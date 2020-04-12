const fs = require('fs');
const path = require('path');
const config = require('config');
const fastify = require('fastify');
const faker = require('faker');
const uuid = require('uuid').v4;
const app = fastify();

const WsServer = require('./ws');
const Engine = require('./engine');
const {
  calcShasum,
  validWorldId,
  validUuid,
  sanitize,
  PKGJSON,
  NAME,
  VERSION
} = require('./util');

const rtInfo = {
  counts: {
    requests: 0,
    byIp: {},
    byRoute: {},
    connections: {
      ok: 0,
      bad: 0
    },
    messages: {
      rx: 0,
      rxBad: 0,
      tx: 0
    }
  }
};

const logBuffer = [];
const logEmitter = console.log;
let logFileStream;

if (config.http.log) {
  logFileStream = fs.createWriteStream(`${config.http.log}`, { flags: 'a', encoding: 'utf8' });
}

let loggingEnabled = true;
let verboseLogging = { chat: config.app.logChatToConsole };
let serverStartTime;

let wsServer;
let engine;
let staticRouteCache = {};

const pauseConsoleLogging = () => { loggingEnabled = false; };

const resumeConsoleLogging = () => {
  let buffered = logBuffer.splice(0);
  buffered.forEach(l => logEmitter(l));
  loggingEnabled = true;
};

const logReq = (req, route) => {
  ++rtInfo.counts.requests;
  let realIps = [req.ip];

  if ('cf-connecting-ip' in req.headers) {
    realIps = [req.headers['cf-connecting-ip']];
  } else if ('forwarded' in req.headers) {
    realIps = req.headers.forwarded.split(/,\s+/)
      .map(x => x.split('=')).filter(x => x[0] === 'for').map(x => x[1]);
  }

  if (!(realIps[0] in rtInfo.counts.byIp)) {
    rtInfo.counts.byIp[realIps[0]] = 0;
  }
  ++rtInfo.counts.byIp[realIps[0]];

  if (route) {
    if (!(route in rtInfo.counts.byRoute)) {
      rtInfo.counts.byRoute[route] = 0;
    }
    ++rtInfo.counts.byRoute[route];
  }

  if ('upgrade' in req.headers && req.headers.upgrade === 'websocket') {
    req.raw = {
      method: 'WS',
      url: req.url,
      headers: req.headers
    }
  }

  log(`${(new Date).toISOString()} ${realIps.join(';').padEnd(16, ' ')} ` + 
    `${req.raw.method.padEnd(4, ' ')} ${req.raw.url} "${req.raw.headers['user-agent']}"`);
};

const log = (str, isReq = false) => {
  if (isReq) {
    return logReq(str);
  }

  if (logFileStream) {
    logFileStream.write((typeof str === 'object' ? JSON.stringify(str) : str) + '\n');
  }

  if (loggingEnabled) {
    return logEmitter(str);
  }

  logBuffer.push(str);
}

const main = async (fullInitCb) => {
  if (!config.redis || !config.redis.url) {
    throw new Error('redis config');
  }

  let redisEnv = config.redis.url.match(/^env:(.*)$/);
  if (redisEnv && redisEnv.length > 1) {
    config.redis.url = process.env[redisEnv[1]];
  }

  const cacheEnv = process.env.FAUNA_ENV || 'prod';
  config.redis.prefix = `${NAME.toLowerCase()}-${cacheEnv}`;

  engine = new Engine({ logger: log, ...config.redis });
  await engine.init();

  app.register(require('fastify-cors'), {
    origin: '*'
  });

  app.listen(config.http.port, config.http.bind).then(() => {
    log(`Listening on ${config.http.bind}:${config.http.port}`);
    serverStartTime = Date.now();
    if (fullInitCb) {
      fullInitCb();
    }
  });

  app.addHook('onClose', (inst, done) => {
    if (logFileStream) {
      logFileStream.end();
    }

    done();
  });

  app.ready(async () => {
    wsServer = new WsServer({ server: app.server, logger: log, rtInfo });

    const sendTimeUpdateTo = (cSock, gtCached) => {
      let curGT = gtCached;
      if (!curGT) {
        curGT = engine.getGameTime();
      }

      cSock.send(JSON.stringify({
        type: 'gametime',
        payload: curGT,
        localTs: Date.now()
      }));
    };

    wsServer.on('listening', (port) => log(`Websocket listening on ${port}`));

    wsServer.on('connection', (cSock) => sendTimeUpdateTo(cSock));

    wsServer.on('chat', (msgObj) => {
      engine.logChatMsg(msgObj);
      if (verboseLogging.chat) {
        log(msgObj);
      }
    });

    if (config.app.sendTimeUpdatesEvery) {
      const timeUpdater = () => {
        const curConns = wsServer.getConnectedCount();
        if (curConns > 0) {
          let curGT = engine.getGameTime();
          Object.values(wsServer.getConnectedSockets()).forEach((cSock) => {
            sendTimeUpdateTo(cSock, curGT);
          });
        }
        setTimeout(timeUpdater, config.app.sendTimeUpdatesEvery * 1000);
      };
      setTimeout(timeUpdater, config.app.sendTimeUpdatesEvery * 1000);
    }

    wsServer.start();
  });

  if (config.http.clientSite && fs.existsSync(config.http.clientSite)) {
    const mimeTypes = {
      '.png': 'image/png',
      '.css': 'text/css',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript'
    };

    const serveStaticAsset = (routePath, fullPath) => {
      const _fill = (routePath, fullPath) => {
        log(`filling static cache with ${fullPath} for key '${routePath}'`);
        staticRouteCache[routePath] = { 
          mtime: fs.statSync(fullPath).mtime,
          data: fs.readFileSync(fullPath)
        };
      };

      if (!(routePath in staticRouteCache)) {
        _fill(routePath, fullPath);
      } else {
        let curMtime = fs.statSync(fullPath).mtime;
        if (curMtime > staticRouteCache[routePath].mtime) {
          log(`${routePath} has been updated:`);
          log(`\t${curMtime} > ${staticRouteCache[routePath].mtime}`);
          _fill(routePath, fullPath);
        }
      }

      return staticRouteCache[routePath].data;
    };

    const setupRoutesForDir = (dir, rPfx) => {
      let dirRes = path.resolve(dir);
      let openDir = fs.opendirSync(dirRes);
      let dirEnt;

      while ((dirEnt = openDir.readSync()) !== null) {
        let resolved = path.resolve(`${dirRes}/${dirEnt.name}`);
        if (dirEnt.isDirectory()) {
          setupRoutesForDir(resolved, dirEnt.name);
        } else {
          let routePath = '/' + (rPfx ? `${rPfx}/` : '') + dirEnt.name;
          let isIndex = dirEnt.name === 'index.html';
          let mime = mimeTypes[path.extname(resolved)];
          log(`Routed${(isIndex ? ' as index' : '')}: GET ${routePath} -> ${resolved} ('${mime}')`);

          const routeResponder = async (req, reply) => {
            logReq(req, routePath);
            reply
              .code(200)
              .header('Content-Type', mime)
              .send(serveStaticAsset(routePath, resolved));
          };

          app.get(routePath, routeResponder);

          if (isIndex) {
            app.get('/', routeResponder);
          }
        }
      }

      openDir.closeSync();
    };

    let cfgResolved = path.resolve(`${__dirname}/${config.http.clientSite}`);
    log(`Routing static client site from ${cfgResolved}:`);
    setupRoutesForDir(cfgResolved);
  }

  app.get('/ping', async (req, reply) => {
    logReq(req, '/ping');
    return VERSION;
  });

  app.post('/world/enter', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/world/enter');

    let wId = retVal.worldId = calcShasum(JSON.stringify(req.body));
    let world = await engine.worlds(wId);

    if (!world) {
      world = { 
        name: faker.address.city() + ', ' + faker.address.country(),
        params: req.body
      };

      engine.worlds(wId, world);
      retVal.isNew = true;
    }

    retVal.world = world;
    return retVal;
  });

  app.get('/world/:worldId', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/world/...');
    if (validWorldId(req.params.worldId)) {
      retVal.world = await engine.worlds(req.params.worldId);
    }
    return retVal;
  });

  app.get('/world/:worldId/block/:x/:y', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/world/../block');

    if (validWorldId(req.params.worldId)) {
      let wId = req.params.worldId;
      let world = await engine.worlds(wId);

      if (world) {
        let x = req.params.x;
        let y = req.params.y;
        let block = await world.grid(x, y);

        if (!block) {
          block = { 
            n: Number.parseFloat(req.query.n),
            inventory: []
          };

          block.type = await world.grid(x, y, block);
          block.count = 1;
        }

        retVal.block = block;
      }
    }

    return retVal;
  });

  app.post('/world/:worldId/block/:x/:y/add', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/world/../block/../add');

    try {
      if (validWorldId(req.params.worldId)) {
        let newInvItem = sanitize(req.body);
        if (newInvItem.payload.length === 0) {
          return;
        }

        let world = await engine.worlds(req.params.worldId);
        let block = await world.grid(req.params.x, req.params.y);
        retVal.newInventoryCount = block.inventory.push(newInvItem);
        await world.grid(req.params.x, req.params.y, block);
        log(block);
      }
    } catch (err) {
      log(`ERR: ${err}`);
      retVal.error = true;
    }

    log(retVal);
    return retVal;
  });

  app.get('/species', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/species');
    return Object.assign({}, retVal, { species: config.game.species });
  });

  app.get('/meta', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/meta');
    return Object.assign({}, retVal, { species: config.game.meta });
  });

  app.post('/avatar', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/avatar');
    retVal.avatarId = await engine.avatars(null, sanitize(req.body, config.app.avatarNameLengthLimit));
    return retVal;
  });

  app.get('/avatar/:avatarId', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/avatar/..');
    if (validUuid(req.params.avatarId)) {
      retVal.avatar = await engine.avatars(req.params.avatarId);
    }
    return retVal;
  });

  app.post('/avatar/:avatarId/loc', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/avatar/../loc/..');
    let { avatarId } = req.params;
    let { worldId, x, y } = req.body;
    if (validUuid(avatarId) && validWorldId(worldId)) {
      retVal = await engine.setAvatarLoc(avatarId, worldId, x, y);
    }
    return retVal;
  });

  const fakers = {
    'firstname': faker.name.firstName
  };

  app.get('/util/faker/:type', async (req, reply) => {
    let retVal = { error: false };
    logReq(req, '/util/faker');
    if (req.params.type in fakers) {
      retVal[req.params.type] = fakers[req.params.type]();
    }
    return retVal;
  });
};

const stop = () => {
  engine.stop();
  app.close();
};

const getRuntimeInfo = () => {
  let retCopy = Object.assign({}, rtInfo, { 
    uptime: (Date.now() - serverStartTime),
    memory: process.memoryUsage()
  });

  if (logFileStream) {
    retCopy.logging = {
      path: logFileStream.path,
      bytesWritten: logFileStream.bytesWritten
    };
  }

  retCopy.counts.consoleBacklog = logBuffer.length;
  rtInfo.counts.connections.current = wsServer.getConnectedCount();

  retCopy.engine = engine.getRuntimeInfo();

  return retCopy;
};

module.exports = {
  start: main,
  stop,
  pauseConsoleLogging,
  resumeConsoleLogging,
  getRuntimeInfo,
  getConnectedSockets: () => wsServer.getConnectedSockets(),
  toggleChatConsoleLogging: () => { return (verboseLogging.chat = !verboseLogging.chat); }
};

