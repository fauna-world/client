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
  list: {
    desc: 'List connected avatars',
    detailDesc: 'Shows a list of currently-connected avatars',
    exec: async (avatarId, wss, args) => {
      let msg = `${wss.getConnectedCount()} currently connected fauna:<br/></br>` + 
        '<ul style="margin-left: -20px; margin-bottom: 0px;">';
      msg += Object.entries(wss.getConnectedSockets()).map(sock => {
        if ('closeReason' in sock[1]) {
          return '';
        }

        `<li><span class="tooltip chatusername"><span class="tooltiptext tooltip_top">` +
        `DM ID: <b>${sock[0].substring(0, 8)}</b></span>` +
        `<img class='chatimg' src='assets/${sock[1].avatar.species}.png'><b>${sock[1].avatar.name}</b> ` +
        `</span></li>`
      }).join('');
      return msg + '</ul>';
    }
  },
  help: {
    desc: 'This help. Give a command name as the sole argument for detailed information on said command.',
    detailDesc: 'Give a command name as the sole argument for detailed information on said command.',
    exec: async (avatarId, wss, args) => {
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
          return `Detailed information on '<b>/${args[0]}</b>':<br/><br/>${slashCommands[args[0]].detailDesc}`;
        } else {
          return `No such command '<b>/${args[0]}</b>'!`;
        }
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
          this.log(`conn ${connKey} didn't 'pong' back: ${this.conns[connKey].waitingOnPong}; killing`);
          this.log(`last heartbeat delta: ${Date.now() - this.conns[connKey].lastHeartbeat}`);
          if (this.conns[connKey].waitingOnPong === 1) {
            this.log('trying polite close first...');
            this.conns[connKey].close(1002, 'ping not ponged');
            ++this.conns[connKey].waitingOnPong;
          } else {
            this.log('not polite this time');
            this.conns[connKey].terminate();
            delete this.conns[connKey];
          }
        } else {
          if (this.conns[connKey].waitingOnPong++) {
            this.log(`${WARN_CHAR} still waiting on a pong from ${connKey} (${this.conns[connKey].waitingOnPong})`);
          }
          //this.log(`pinging ${connKey} (${this.conns[connKey].waitingOnPong})`);
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
        let closeReason = 1008;
        if ('closeReason' in this.conns[wsAvatarId]) {
          this.log(`but has a marked close reason '${this.conns[wsAvatarId].closeReason}'!`);
          closeReason = this.conns[wsAvatarId].closeReason;
        }
        this.conns[wsAvatarId].close(closeReason, 'already connected');
        //delete this.conns[wsAvatarId];
      } else {
        this.log(`${(isReconnect ? 'reconn' : 'new')} ws for ${wsAvatarId}`);
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
        this.log(`closing ws to ${wsAvatarId} ${this.conns[wsAvatarId]} ${e}`);
        if (wsAvatarId in this.conns) {
          if ('lastHeartbeat' in this.conns[wsAvatarId]) {
            this.log(`last heartbeat delta: ${Date.now() - this.conns[wsAvatarId].lastHeartbeat}`);
          } else {
            this.log(`no last heartbeat - ${WARN_CHAR} zombie!`);
          }
          this.conns[wsAvatarId].closeReason = e;
          //delete this.conns[wsAvatarId];
        }
      });

      c.on('ping', (data) => {
        this.log(`${WARN_CHAR} PING? ${wsAvatarId}`);
        this.log(data);
        this.log(typeof data);
        this.log(`data! ${data.toString()}`);
        if (wsAvatarId in this.conns) {
          this.log("we'll count it! ponging back");
          this.conns[wsAvatarId].pong(data);
          this.conns[wsAvatarId].waitingOnPong = 0;
        }
      });

      c.on('pong', () => {
        //this.log(`pong from ${wsAvatarId}`);
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
