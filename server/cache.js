const Redis = require('ioredis');

module.exports = class Cache {
  constructor (opts) {
    this.url = opts.url;
    this.prefix = opts.prefix;
    this.engine = opts.engine;
    this.log = opts.logger || console.log;
    this.r = null;
  }

  async init() {
    try {
      this.r = new Redis(this.url);
      let keys = await this.r.keys(`${this.prefix}*`);
      this.log(`Connected to redis://${this.r.options.host}:${this.r.options.port}; ` + 
        `${keys.length} keys; up ${this.r.serverInfo.uptime_in_days} days`);
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

    this.log(`new avatar ${avatarId}:`);
    this.log(newAvatar);

    await this.r.hset(key, avatarId, JSON.stringify(newAvatar));
    return avatarId;
  }

  async worlds(worldId, newWorld) {
    const key = `${this.prefix}:worlds`;

    const gridGetSet = async (ggsWorldId, x, y, nObj) => {
      let gKey = `${this.prefix}:grid:${ggsWorldId}`;
      let gField = `${x}:${y}`;
      let countKey = gField + ':count';

      if (nObj) {
        // XXX TODO: this whole thing should be in the engine itself!
        return this.engine.submitWriteOp(() => {
          this.r.hset(gKey, gField, JSON.stringify(nObj));
          this.r.hset(gKey, countKey, 1);
        });
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

    this.log(`new world ${worldId}:`);
    this.log(newWorld);

    return this.r.hset(key, worldId, JSON.stringify(newWorld));
  }
};