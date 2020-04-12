const config = require('config');
const Redis = require('ioredis');

module.exports = class Cache {
  constructor (opts) {
    this.url = opts.url;
    this.prefix = opts.prefix;
    this.engine = opts.engine;
    this.log = opts.logger || console.log;

    this.olog = this.log
    this.log = (str, req) => {
      if (req) return this.olog(str, req);
      this.olog(`${(new Date).toISOString()} [CCH] ${(typeof str === 'object' ? JSON.stringify(str) : str)}`);
    };

    this.r = null;
  }

  async init() {
    try {
      this.r = new Redis(this.url);
      let keys = await this.r.keys(`${this.prefix}*`);
      this.log(`Connected to redis://${this.r.options.host}:${this.r.options.port}; ` + 
        `'${this.prefix}*' has ${keys.length} keys; up ${this.r.serverInfo.uptime_in_days} days`);
    } catch(err) {
      this.log('redis connection failed: ' + err);
      throw err;
    };
  }

  async logChatMsg(msgObj) {
    this.r.lpush(`${this.prefix}:chat:${msgObj.to}`, JSON.stringify(msgObj));
  }

  async avatars(avatarId, newAvatar) {
    if (avatarId === null && newAvatar) {
      throw new Error(`attempt to create new avatar without ID! ${JSON.stringify(newAvatar)}`);
    }

    const key = `${this.prefix}:avatars`;

    if (avatarId && !newAvatar) {
      return JSON.parse(await this.r.hget(key, avatarId));
    }

    this.log(`writing avatar ${avatarId}:`);
    this.log(newAvatar);

    await this.r.hset(key, avatarId, JSON.stringify(newAvatar));
    return avatarId;
  }

  async worlds(worldId, newWorld) {
    const key = `${this.prefix}:worlds`;

    const gridGetSet = async (ggsWorldId, x, y, nObj, hasPlayerPresence = false) => {
      let gKey = `${this.prefix}:grid:${ggsWorldId}`;
      let gField = `${x}:${y}`;
      let countKey = gField + ':count';

      if (hasPlayerPresence) {
        // XXX TODO: this should be in the engine too! ugh
        // player presence is required to generate new items, so do that here
        // remember: seasonal boosts depending on block type! (check notes!)
      }

      if (nObj) {
        // XXX TODO: this whole thing should be in the engine itself!
        // also, the following effectively 'hardcodes' terrian type
        // into the block object, and that's ultimately because this deferred
        // write ... really need to fix that.
        let bTypes = config.game.block.types;
        nObj.type = bTypes[Object.keys(bTypes).sort()
            .find(bk => Number.parseFloat(bk) >= nObj.n)];

        this.engine.submitWriteOp(() => {
          this.r.hset(gKey, gField, JSON.stringify(nObj));
          this.r.hset(gKey, countKey, 1);
        });

        return nObj.type;
      }

      let retVal = JSON.parse((await this.r.hget(gKey, gField)));

      if (retVal) {
        // safe to do outside the write loop because its atomic in redis 
        // (also monotonic in a single direction)
        let count = await this.r.hincrby(gKey, countKey, 1);
        retVal = { ...retVal, count };
      }

      return retVal;
    };

    // form one, get world by id (one argument)
    // if DNE in redis, will return null
    if (worldId && !newWorld) {
      let rWorld = JSON.parse(await this.r.hget(key, worldId));
      if (rWorld) {
        rWorld.grid = gridGetSet.bind(null, worldId);
      }
      return rWorld;
    }

    let curWorlds = await this.r.hgetall(key);

    // form two, get all worlds (no arguments)
    if (!worldId) {
      Object.keys(curWorlds).forEach(worldKey => {
        curWorlds[worldKey] = JSON.parse(curWorlds[worldKey]);
        curWorlds[worldKey].grid = gridGetSet.bind(null, worldKey);
      });

      return curWorlds;
    }

    // form three, set new world (two args)
    // if worldId already exists, return null

    if (worldId in curWorlds) {
      return null;
    }

    this.log(`writing world ${worldId}:`);
    this.log(newWorld);

    return this.r.hset(key, worldId, JSON.stringify(newWorld));
  }
};