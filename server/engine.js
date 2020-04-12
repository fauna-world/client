const config = require('config');
const moment = require('moment');
const uuid = require('uuid').v4;
const Cache = require('./cache');

const INITIAL_GAMETIME = moment(0).subtract(1969, 'years');

module.exports = class Engine {
  constructor (opts) {
    this.log = opts.logger || console.log;
    this.writeOps = [];
    this.cache = new Cache({ engine: this, ...opts });
    this.tickFreq = Math.floor(1000 / config.engine.tickFreqHz);
    this.tickCount = 0;
    this.gameEpoch = 0;
    this.gameTime = INITIAL_GAMETIME;

    this._olog = this.log;
    this.log = (str) => this._olog(`${(new Date).toISOString()} [ENG] ${str}`);
    
    this.run = true;
  }

  _setTick() {
    if (this.run) {
      this.tickHandle = setTimeout(this.tick.bind(this), this.tickFreq);
    }
  }

  async tick() {
    ++this.tickCount;
    this.gameTime = this.gameTime.add(config.engine.timeMult * this.tickFreq, 'milliseconds');
    if (!this.gameTime.isValid()) {
      this.gameTime = INITIAL_GAMETIME;
      this.gameEpoch++;
    }
    const localWriteOps = this.writeOps.splice(0);
    if (localWriteOps.length) {
      this.log(`tick ${this.tickCount}.${this.gameEpoch}.${this.gameTime.valueOf()} processing ${localWriteOps.length} ops:`);
      const opResults = [];
      // todo; pipeline for each op?
      for (let writeOp of localWriteOps) {
        opResults.push((await writeOp()));
      }
      this.log(`op results: ${JSON.stringify(opResults)}`);
    }
    this._setTick();
  }

  async init() {
    await this.cache.init();
    this._setTick();
  }

  stop() {
    this.run = false;
  }

  submitWriteOp(opFunc) {
    return this.writeOps.push(opFunc);
  }

  async submitPromisedWriteOpReturningId(newIdOrNull, newEntity, properOp) {
    // TODO: this should be in the cache! these are 'returning id' funcs...
    if (newIdOrNull === null) {
      newIdOrNull = uuid();
    }

    return new Promise((resolve) => {
      this.submitWriteOp(async () => { 
        let newRetId = await properOp(newIdOrNull, newEntity);
        resolve(newRetId);
      })
    });
  }

  async worlds(worldId, newWorld) {
    if (newWorld) {
      return this.submitPromisedWriteOpReturningId(worldId, newWorld, 
        this.cache.worlds.bind(this.cache));
    }

    return this.cache.worlds(worldId);
  }

  async avatars(avatarId, newAvatar) {
    if (newAvatar) {
      return this.submitPromisedWriteOpReturningId(avatarId, newAvatar, 
        this.cache.avatars.bind(this.cache));
    }

    return this.cache.avatars(avatarId);
  }

  logChatMsg(msgObj) {
    return this.cache.logChatMsg(msgObj);
  }

  getGameTime() {
    return { time: this.gameTime.valueOf(), epoch: this.gameEpoch };
  }

  getRuntimeInfo() {
    return {
      gameTimeStr: `${this.gameTime}`,
      gameTime: this.gameTime.valueOf(),
      gameEpoch: this.gameEpoch,
      tickCount: this.tickCount
    };
  }
};
