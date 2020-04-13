const config = require('config');
const uuid = require('uuid').v4;
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

  async submitFeedback(fBack) {
    this.r.lpush(`${this.prefix}:feedback`, JSON.stringify(fBack));
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

    const gridGetSet = async (ggsWorldId, x, y, nObj, hasPlayerPresence) => {
      let gKey = `${this.prefix}:grid:${ggsWorldId}`;
      let gField = `${x}:${y}`;
      let countKey = gField + ':count';

      const getCurrentBlock = async () => JSON.parse((await this.r.hget(gKey, gField)));

      if (hasPlayerPresence) {
        // XXX TODO: this should be in the engine too! ugh
        let curBlock = await getCurrentBlock();
        let curGMonth = config.game.block.seasons[(new Date(this.engine.getGameTime().time)).getMonth()].toLowerCase();
        let seasonGenChanceBoost = 0.0;

        if (curGMonth === config.game.block.boosts[curBlock.type]) {
          seasonGenChanceBoost = Math.random() * config.game.meta.maxSeasonalDropChanceBoost;
          this.log(`block ${gField} is ${curBlock.type}, has '${curGMonth}' boost: using value ${seasonGenChanceBoost}`);
        }

        // only 'consumable' items right now!
        let consItems = config.game.items.consumable;
        let generatedItems = consItems.reduce((generated, chanceItem) => {
          // should nerf genChance based on inverse distance traveled: better chance the farther the distance
          // (means we need to pass in distance to this func, too!)
          // (would prevent one-block-at-a-time longevity technique)
          // ***OR***! make some kind of 'cooldown' or 'tiring', e.g. can only consume one item per block visit!
          // or, a block tiring e.g. if generated in last X ticks, genChance is reduced
          // the latter is much more difficult to get right... one-item-per-block-consumption would be an easy
          // implementation and could make things quite interesting (e.g. lots of left-behind items, also makes chosing next path more interesting)
          //  also, instead of one-block-per, it can be X-blocks-per, where it is dependent on yet-another species stat! (tranquility! which i haven't brought back yet but should!)
          /// it's perfect! the more 'tranquil' you are, the better you're able to stay in one place for longer and eat/consume more!
          /// also works since the natural balance of tranquility is movement/agility (need to work agility in somehow now!)

          let _x;
          let genChance = (chanceItem.generate || config.game.meta.defaultGenerateChance) + seasonGenChanceBoost;
          if (chanceItem.modifiers.generate) {
            let genBoostStat = config.game.species[hasPlayerPresence].stats[chanceItem.modifiers.generate];
            // gen boost allows a *max* of 5% boost to genChance with max genBoostStat
            let genBoost = (_x = Math.random()) * (0.05 / (config.game.meta.statMax / genBoostStat));
            this.log(`modifying ${genChance} with ${genBoost} -> ${genChance + genBoost} (stat=${genBoostStat}, rand=${_x})`);
            genChance += genBoost;
          }

          if (genChance > (_x = Math.random())) {
            this.log(`${genChance} > ${_x}, generating '${chanceItem.name}'!`);

            let rangeBoost = 0;
            if (chanceItem.modifiers.range) {
              this.log(`modifying range based on ${chanceItem.modifiers.range} ` +
                `-> ${config.game.species[hasPlayerPresence].stats[chanceItem.modifiers.range]}`);
              let rangeBoostStat = config.game.species[hasPlayerPresence].stats[chanceItem.modifiers.range];
              rangeBoost = (1 + Math.random()) * (0.9 + (1 / (config.game.meta.statMax / rangeBoostStat)));
              this.log(`rangeBoost = ${rangeBoost} -> ${Math.ceil(rangeBoost)}`);
              rangeBoost = Math.ceil(rangeBoost);
            }

            const rMin = chanceItem.range[0];
            const rMax = chanceItem.range[1] + rangeBoost;
            let genStatFromRange = (Math.random() * (rMax - rMin)) + rMin;
            this.log(`genStatFromRange = ${genStatFromRange} [${rMin}, ${rMax}] -> ${Math.ceil(genStatFromRange)}`);

            const newItem = { 
              type: 'item',
              payload: {
                type: 'consumable',
                name: chanceItem.name,
                affect: chanceItem.affect,
                stat: Math.ceil(genStatFromRange),
                id: uuid()
              },
              localTs: Date.now()
            };

            this.log(`generated: ${JSON.stringify(newItem)}`);
            generated.push(newItem);
          } else {
            this.log(`${genChance} <= ${_x}, NOT generating '${chanceItem.name}'!`);
          }

          return generated;
        }, []);

        if (generatedItems.length) {
          if (!nObj) {
            nObj = curBlock;
          }

          this.log(`pushing ${generatedItems.length} onto block ${ggsWorldId}:${x},${y} inventory`);
          nObj.inventory.push(...generatedItems);
        }
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

        // XXX ugh, special cases are abounding...
        return hasPlayerPresence ? nObj : nObj.type;
      }

      let retVal = await getCurrentBlock();

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