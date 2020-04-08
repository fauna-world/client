const ws = require('ws');
const url = require('url');
const config = require('config');
const { sanitize, NAME, VERSION } = require('./util');
const { ALERT_CHAR } = require('./style');

module.exports = class WsServer {
  constructor (opts) {
    this.server = opts.server;
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
        if (this.conns[connKey].waitingOnPong === true) {
          this.log(`conn ${connKey} didn't 'pong' back: removing`);
          this.conns[connKey].close();
          delete this.conns[connKey];
          return;
        }

        this.conns[connKey].waitingOnPong = true;
        this.conns[connKey].ping();
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

  onConnection(c, req) {
    this.log(req, true);
    const qs = url.parse(req.url).query.split('&').map(x => x.split('=')).reduce((a, x) => {
      a[x[0]] = x[1];
      return a;
    }, {});

    let err;
    if (config.app.cookieName in qs) {
      let wsAvatarId = qs[config.app.cookieName];

      if (wsAvatarId in this.conns) {
        this.log(`already have a connection for ${wsAvatarId}! tossing it`);
        this.conns[wsAvatarId].close();
        delete this.conns[wsAvatarId];
      } else {
        this.log(`new ws connection for ${wsAvatarId}`);
      }
      
      ++this.rtInfo.counts.connections.ok;
      c.rxQueue = [];
      c.waitingOnPong = false;
      c.origSend = c.send;
      c.send = (msg) => {
        ++this.rtInfo.counts.messages.tx;
        return c.origSend(msg);
      };

      this.conns[wsAvatarId] = c;

      c.send(JSON.stringify({
        type: 'chat',
        payload: `Hello, I'm ${NAME} ${VERSION}! You may find ` +
	      'my source code <a href="https://github.com/fauna-world/fauna" target="_blank">here</a>. ' +
	      'You are now connected. Stay home, wash your hands, and enjoy the beautiful around you!',
        from: { name: NAME, id: -1 },
        localTs: Date.now(),
        to: 'global'
      }));

      if ('connection' in this.onmap) {
        this.onmap.connection(c);
      }

      c.on('message', (msgStr) => {
        try {
          let msgObj = JSON.parse(msgStr);
          msgObj.payload = sanitize(msgObj.payload);

          // don't post empty messages, which may not be empty on the
          // client end but end up empty after sanitization
          if (msgObj.payload.length === 0) {
            return;
          }
          
          msgObj.rxTs = Date.now();
          msgObj.tsDelta = msgObj.rxTs - msgObj.localTs;
          ++this.rtInfo.counts.messages.rx;

          if (msgObj.type === 'chat') {
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
          } else {
            c.rxQueue.push(msgObj);
          }
        } catch (err) {
          this.log(`bad msg rx'ed '${msgStr}': ${err}`);
          this.log(err.stack);
          ++this.rtInfo.counts.messages.rxBad;
        };
      });

      c.on('close', () => {
        this.log(`closing ws to ${wsAvatarId}`);
        delete this.conns[wsAvatarId];
      });

      c.on('pong', () => {
        if (!(wsAvatarId in this.conns)) {
          this.log(`${ALERT_CHAR} conn ${wsAvatarId} ponged but is not in conns list!!`);
          return;
        }

        if (!this.conns[wsAvatarId].waitingOnPong) {
          this.log(`conn ${wsAvatarId} ponged without wait!`);
          return;
        }
        this.conns[wsAvatarId].waitingOnPong = false;
      });
    } else {
      err = 'BAD ACTOR';
      c.close();
    }

    if (err) {
      ++this.rtInfo.counts.connections.bad;
      this.log(`ws connection error: ${err}`);
      c.close();
    }
  }
};
