const config = require('config');
const moment = require('moment');
const uuid = require('uuid').v4;
const Cache = require('./cache');
const { NAME, manhattanDist, manhattanDistObj } = require('./util');

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

    this.olog = this.log
    this.log = (str, req) => {
      if (req) return this.olog(str, req);
      this.olog(`${(new Date).toISOString()} [ENG] ${(typeof str === 'object' ? JSON.stringify(str) : str)}`);
    };
    
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
      // TODO: this 'implicit newlife' should probably be more explicit...
      if (!('life' in newAvatar)) {
        newAvatar.life = config.game.meta.lifeMax;
        newAvatar.scores = {
          moved: 0
        };
        newAvatar.consumeAllowed = config.game.species[newAvatar.species].stats[config.game.meta.consumptionAllowanceAttr];
        this.cache.incrLifetimeMetric('avatar-births', 1);
      }

      return this.submitPromisedWriteOpReturningId(avatarId, newAvatar, 
        this.cache.avatars.bind(this.cache));
    }

    return this.cache.avatars(avatarId);
  }

  async setAvatarLoc(avatarId, worldId, x, y) {
    let curAvatar = await this.cache.avatars(avatarId);
    let world = await this.cache.worlds(worldId);
    let retVal = { success: false };

    if (curAvatar && world) {
      const sstats = config.game.species[curAvatar.species].stats;
      let moveAllowed = false;

      if (curAvatar.loc) {
        if (curAvatar.loc.worldId !== worldId) {
          throw new Error('trying to move worlds!');
        }

        this.log(`cur=(${curAvatar.loc.x}, ${curAvatar.loc.y}) new=(${x}, ${y})`);
        const sMax = config.game.meta.statMax;
        const manhattan = manhattanDist(x, y, curAvatar.loc.x, curAvatar.loc.y);
        const effectiveMh = (manhattan / (0.9 + (1 / (sMax / sstats.mobility)))) * config.game.meta.overallMovementWeight;
        const ceilEffMh = Math.round(effectiveMh);
        this.log(`mobility=${sstats.mobility} manhattan=${manhattan} effectiveMh=${ceilEffMh}(${effectiveMh})`);

        // should there be seasonal movement variation?
        // penalize crossing terrian gradient, weighted by agility?
        //    this is hard! if pythag: how do we know which blocks are crossed?
        //    if manhattan, how do we allow users to select route? do we?
        //    could try to use stddev of all blocks transited as easy measure of
        //    agility cost, but even then must know *which* blocks to incl in stddev!
        //  may not really need this at all, as can use the terrian gradient
        //  instead for diff mechanic (seasonal variation)

        // if 'movement allowed remaining' > above calc'ed score; allow move
        if (curAvatar.life >= ceilEffMh || curAvatar.life === 1) {
          moveAllowed = true;
          curAvatar.life -= ceilEffMh;
          if (curAvatar.life < 0) curAvatar.life = 0;
          curAvatar.scores.moved += manhattan;
          this.cache.incrLifetimeMetric('life-lost-flying', ceilEffMh);
          this.cache.incrLifetimeMetric('distance-flown', manhattan);
        } else {
        }
      } else {
        moveAllowed = true;
      }

      if (moveAllowed) {
        const locObj = { worldId, x, y };
        const isDead = curAvatar.life === 0;

        if (!curAvatar.loc) {
          curAvatar.origin = locObj;
        }

        curAvatar.loc = locObj;
        curAvatar.consumeAllowed = sstats[config.game.meta.consumptionAllowanceAttr];

        if (isDead) {
          curAvatar.scores.fromOrigin = manhattanDistObj(curAvatar.origin, curAvatar.loc);
          this.cache.registerScores(avatarId, curAvatar.scores);
        }

        await this.avatars(avatarId, curAvatar);

        retVal.avatar = curAvatar;
        retVal.block = await world.grid(x, y, null, curAvatar.species);
        retVal.success = true;

        if (isDead) {
          const _poster = { name: NAME, species: 'game' };
          
          retVal.block.inventory.push({
            type: 'note',
            payload: `[RIP] A ${curAvatar.species} named <b>${curAvatar.name}</b> perished here on ` + 
              `<b>${(new Date()).toUTCString()}</b> after ` +
              `flying a total distance of <b>${curAvatar.scores.moved}</b> blocks, ` + 
              `<b>${curAvatar.scores.fromOrigin}</b> blocks from where they began.`,
            poster: _poster
          });

          retVal.block.inventory.push({
            type: 'tombstone',
            payload: { avatar: curAvatar },
            poster: _poster
          })

          world.grid(x, y, retVal.block);
          this.cache.incrLifetimeMetric('avatar-deaths', 1);
        }
      }
    }

    return retVal;
  }

  async consumeItem(avatarId, worldId, x, y, itemId) {
    let curAvatar = await this.cache.avatars(avatarId);
    let retVal = { success: false };

    if (curAvatar.consumeAllowed && curAvatar.life > 0) {
      let world = await this.cache.worlds(worldId);
      let block = await world.grid(x, y);

      if (block.inventory.length) {
        let foundItem = block.inventory.find(itemCont => itemCont.payload.id === itemId).payload;
        if (foundItem) {
          // XXX: this whole thing should be atomic! (pipelined?)
          block.inventory = block.inventory.filter(itemCont => itemCont.payload.id !== itemId);
          await world.grid(x, y, block);

          this.cache.incrLifetimeMetric('life-gained-eating', foundItem.stat);
          this.cache.incrLifetimeMetric('items-eaten', 1);

          curAvatar.life += foundItem.stat;
          curAvatar.consumeAllowed--;
          await this.avatars(avatarId, curAvatar);

          retVal.block = block;
          retVal.avatar = curAvatar;
          retVal.success = true;
        }
      }
    }

    return retVal;
  }

  logChatMsg(msgObj) {
    this.cache.logChatMsg(msgObj);
  }

  submitFeedback(fBack) {
    this.cache.submitFeedback(fBack);
  }

  async queryHighScores(type, limit = 10) {
    const _allowedTypes = config.game.meta.allowedHighScoreTypes;

    let ret;

    if (type === '*') {
      ret = {};
      for (let qType of _allowedTypes) {
        ret[qType] = await this.queryHighScores(qType, limit);
      }
    } else {
      if (_allowedTypes.indexOf(type) === -1) {
        return null;
      }
      
      ret = await this.cache.queryHighScores(type, limit);
    }

    return ret;
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
