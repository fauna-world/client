const ws = require('ws');
const fs = require('fs');
const url = require('url');
const config = require('config');
const { sanitize, NAME, VERSION } = require('./util');
const { ALERT_CHAR, WARN_CHAR } = require('./style');

const motdInterpolations = {
  NAME,
  VERSION
};

const scoreCatHeadings = {
  'moved': 'Total distance flown',
  'fromOrigin': 'Distance flown from start block'
}

// TODO: really need to return structured data to the client with these,
// to let the client render them! way too much markup in here
const slashCommands = {
  feedback: {
    desc: 'Send feedback to Fauna developers',
    detailDesc: 'All text after the <b>/feedback</b> command itself will be sent to Fauna developers. ' +
      'If you desire a response and so chose, please include contact information. Thank you!',
    exec: async (avatarId, wss, args) => {
      wss.engine.submitFeedback({
        type: 'feedback',
        from: avatarId,
        localTs: Date.now(),
        payload: args.join(' ')
      });
      return 'Many thanks for taking the time to submit feedback! If applicable, we will be in touch post-haste.';
    }
  },
  help: {
    desc: 'This help. Give a command name as the sole argument for detailed information on said command.',
    detailDesc: 'Give a command name as the sole argument for detailed information on said command.',
    exec: async (_, wss, args) => {
      if (!args.length) {
        let msg = 'The following commands are available:<br/><br/>';
        msg += Object.keys(slashCommands).map(slashName =>
          `/<b>${slashName}</b> &mdash; ${slashCommands[slashName].desc}`
        ).join('<br/>');
        return msg + '<br/>';
      } else {
        if (args[0].charAt(0) === '/') {
          args[0] = args[0].substring(1);
        }

        if (args[0] in slashCommands) {
          return `${slashCommands[args[0]].detailDesc}`;
        } else {
          return `No such command '<b>/${args[0]}</b>'!`;
        }
      }
    }
  },
  scores: {
    desc: 'Query high scores',
    detailDesc: 'Query the high scores in each category: without argument lists the top 5 scores in all categories, ' +
      'with an argument lists the top 10 scores in that category.<br/><br/>Currently available category arguments: ' +
      config.game.meta.allowedHighScoreTypes.map(x => `<b>${x}</b> ("${scoreCatHeadings[x]}")`).join(', ') + '',
    exec: async (_, wss, args) => {
      let scores = await wss.engine.queryHighScores(args.length ? args[0] : '*', args.length ? 9 : 4);

      const renderScoresList = (type, list) => {
        let retStr = `<table class='scoretable'><tr><td colspan=3><b>${scoreCatHeadings[type]}</b>:</td></tr>` +
          '<tr style="text-decoration: underline;"><td class="cellcent" style="width: 10%">Pos.</td>' + 
          '<td class="cellcent">Score</td><td>Player</td></tr>';

        retStr += list.reduce((accStr, obj, idx) => {
          return accStr + `<tr><td class='cellcent'>${idx + 1}</td><td class='cellcent'><b>${obj.scores[type]}</b></td>` +
            `<td><img class='chatimg' src='assets/${obj.species}.png'>${obj.name}</td></tr>`;
        }, '');

        return retStr + '</table>';
      };

      if (!scores) {
        return 'Invalid category';
      }

      if (!Array.isArray(scores)) {
        return Object.keys(scores).reduce((accStr, sKey) => {
          return accStr + renderScoresList(sKey, scores[sKey]) + '<br/>';
        }, '');
      }
      else {
        return renderScoresList(args[0], scores);
      }
    }
  }
};

module.exports = class WsServer {
  constructor (opts) {
    this.server = opts.server;
    this.engine = opts.engine;
    this.log = opts.logger || console.log;
    this.rtInfo = opts.rtInfo || {
      counts: {
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

    this.olog = this.log
    this.log = (str, req) => {
      if (req) return this.olog(str, req);
      this.olog(`${(new Date).toISOString()} [WSS] ${(typeof str === 'object' ? JSON.stringify(str) : str)}`);
    };

    this.onmap = {};
    this.conns = {};
    this.wsPingerHandle = null;
  }

  start() {
    // CF proxies WS connections just fine, but nginx needs setup: 
    //  https://www.nginx.com/blog/websocket-nginx/
    // 'http' portion goes in nginx.conf, 'server' portion in sites-enabled/default
    this.wsServer = new ws.Server({ server: this.server, port: config.http.wsPort });
    
    this.wsServer.on('listening', this.onListening.bind(this));
    this.wsServer.on('connection', this.onConnection.bind(this));
    this.wsServer.on('error', (err) => {
      this.log(`ws server socket error!`);
      this.log(err);
    });
  }

  on(event, handler) {
    this.onmap[event] = handler;
  }

  getConnectedCount() {
    return Object.keys(this.conns).length;
  }

  getConnectedSockets() {
    return Object.assign({}, this.conns);
  }

  wsPinger() {
    const realPinger = () => {
      Object.keys(this.conns).forEach((connKey) => {
        if (this.conns[connKey].waitingOnPong > 0) {
          // try to politely close the connection on first missed ping
          if (this.conns[connKey].waitingOnPong === 1) {
            this.conns[connKey].close(1001, 'Going Away');
            ++this.conns[connKey].waitingOnPong;
          } else { // not politely on the second
            this.conns[connKey].terminate();
            delete this.conns[connKey];
          }
        } else {
          if (this.conns[connKey].waitingOnPong++) {
            this.log(`${WARN_CHAR} still waiting on a pong from ${connKey} (${this.conns[connKey].waitingOnPong})`);
          }
          
          this.conns[connKey].ping(Buffer.from('PING', 'utf8'));
        }
      });
      this.wsPingerHandle = setTimeout(realPinger, config.http.wsPingFreq * 1000);
    };

    if (!this.wsPingerHandle) {
      realPinger();
    }
  }

  onListening() {
    this.wsPinger();
    if ('listening' in this.onmap) {
      this.onmap.listening(config.http.wsPort);
    }
  }

  async onConnection(c, req) {
    this.log(req, true);
    const qs = url.parse(req.url).query.split('&').map(x => x.split('=')).reduce((a, x) => {
      a[x[0]] = x[1];
      return a;
    }, {});

    let err;
    if (config.app.cookieName in qs) {
      let wsAvatarId = qs[config.app.cookieName];
      let isReconnect = qs.rc;

      if (wsAvatarId in this.conns && !isReconnect) {
        this.log(`already have a connection for ${wsAvatarId} (${this.conns[wsAvatarId].waitingOnPong})! tossing it`);
        this.conns[wsAvatarId].close(1011, 'Internal Error');
      } else {
        if (isReconnect && wsAvatarId in this.conns) {
          this.conns[wsAvatarId].waitingOnPong = 0;
        }
      }

      this.conns[wsAvatarId] = c;
      
      ++this.rtInfo.counts.connections.ok;
      c.rxQueue = [];
      c.waitingOnPong = 0;
      c.lastHeartbeat = Date.now();
      c.avatar = await this.engine.avatars(wsAvatarId);
      c.origSend = c.send;
      c.send = (msg) => {
        ++this.rtInfo.counts.messages.tx;
        return c.origSend(msg);
      };

      if (!isReconnect) {
        let motd = `Hello, I'm ${NAME} ${VERSION}! You are now connected.`;
        if (fs.existsSync(config.app.motdFile)) {
          motd = fs.readFileSync(config.app.motdFile, { encoding: 'utf8' })
            .replace(/\${([A-Z_]+)}/g, (_, group1) => { 
              return group1 in motdInterpolations ? motdInterpolations[group1] : group1; });
        }

        c.send(JSON.stringify({
          type: 'chat',
          payload: motd,
          from: { name: NAME, id: -1 },
          localTs: Date.now(),
          to: 'global'
        }));
      }
      else {
        c.send(JSON.stringify({
          type: 'reconnect',
          from: { name: NAME, id: -1 },
          localTs: Date.now(),
          to: 'global'
        }));
      }

      if ('connection' in this.onmap) {
        this.onmap.connection(c);
      }

      c.on('message', async (msgStr) => {
        try {
          let msgObj = JSON.parse(msgStr);
          msgObj.payload = sanitize(msgObj.payload);
          
          msgObj.rxTs = Date.now();
          msgObj.tsDelta = msgObj.rxTs - msgObj.localTs;
          ++this.rtInfo.counts.messages.rx;

          if (msgObj.type === 'chat') {
            // don't post empty messages, which may not be empty on the
            // client end but end up empty after sanitization
            if (msgObj.payload.length === 0) {
              return;
            }

            msgObj.payload = msgObj.payload.trim();

            if (msgObj.payload.charAt(0) === '/') {
              let cmdParts = msgObj.payload.substring(1).split(/\s+/);
              let cmd = cmdParts[0] in slashCommands ? cmdParts.shift() : 'help';
              let cmdResp = await slashCommands[cmd].exec(wsAvatarId, this, cmdParts);
              c.send(JSON.stringify({
                type: 'chat',
                payload: cmdResp,
                from: { name: NAME, id: -1 },
                localTs: Date.now(),
                to: wsAvatarId
              }));

              return;
            }

            let targets = [];

            if (msgObj.to === 'global') {
              targets = Object.values(this.conns);
            } else {
              if (msgObj.to in this.conns) { // direct message
                targets = [this.conns[msgObj.to]];
              }
            }
            
            let saniStr = JSON.stringify(msgObj);
            targets.forEach(conn => conn.send(saniStr));
            if ('chat' in this.onmap) {
              this.onmap.chat(msgObj);
            }
          } else if (msgObj.type === 'heartbeat') {
            // TODO: need to have a 'hb killer'; client should send hb cadence
            // along (maybe just with connect calls? as query string?) and if
            // they haven't sent heartbeat in N of those periods (config'ed),
            // will need to close like the pinger does above
            if (!(wsAvatarId in this.conns)) {
              this.log(`${ALERT_CHAR} heartbeat from nontracked ${wsAvatarId}!`);
              this.log(msgStr);
              c.close(1001, 'Going Away');
              return;
            }
            this.conns[wsAvatarId].lastHeartbeat = Date.now();
          } else {
            c.rxQueue.push(msgObj);
          }
        } catch (err) {
          this.log(`bad msg rx'ed '${msgStr}': ${err}`);
          this.log(err.stack);
          ++this.rtInfo.counts.messages.rxBad;
        };
      });

      c.on('close', (e) => {
        this.log(`ws to ${wsAvatarId} was closed: ${e}`);
        if (wsAvatarId in this.conns) {
          if (!('lastHeartbeat' in this.conns[wsAvatarId])) {
            this.log(`no last heartbeat - ${WARN_CHAR} zombie!`);
          }
          delete this.conns[wsAvatarId];
        }
      });

      c.on('ping', (data) => {
        if (wsAvatarId in this.conns) {
          this.conns[wsAvatarId].pong(data);
        }
      });

      c.on('pong', () => {
        if (!(wsAvatarId in this.conns)) {
          this.log(`${ALERT_CHAR} conn ${wsAvatarId} ponged but is not in conns list!!`);
          return;
        }

        if (!this.conns[wsAvatarId].waitingOnPong) {
          this.log(`${ALERT_CHAR} conn ${wsAvatarId} ponged without wait!`);
          return;
        }

        this.conns[wsAvatarId].waitingOnPong = 0;
      });

      c.on('error', (err) => {
        this.log(`${ALERT_CHAR} ws ${wsAvatarId} err!`);
        this.log(err);
      });

      c.on('unexpected-response', (req, resp) => {
        this.log(`${WARN_CHAR} ws ${wsAvatarId} u-r!`);
        this.log(req);
        this.log(resp);
      });
    } else {
      err = 'BAD ACTOR';
      c.terminate();
    }

    if (err) {
      ++this.rtInfo.counts.connections.bad;
      this.log(`ws connection error: ${err}`);
      c.terminate();
    }
  }
};
