const config = require('config');
const uuid = require('uuid').v4;
const Redis = require('ioredis');
const noise = require('./noise');

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

      this.consItems = Object.keys(config.game.items).reduce((acc, curType) => {
        acc.push(config.game.items[curType].map(cur => Object.assign(cur, { type: curType })));
        return acc;
      }, []).flat();
    } catch(err) {
      this.log('redis connection failed: ' + err);
      throw err;
    };
  }

  async logChatMsg(msgObj) {
    this.incrLifetimeMetric('chat-messages', 1);
    this.r.lpush(`${this.prefix}:chat:${msgObj.to}`, JSON.stringify(msgObj));
  }

  async submitFeedback(fBack) {
    this.incrLifetimeMetric('feedback-submitted', 1);
    this.r.lpush(`${this.prefix}:feedback`, JSON.stringify(fBack));
  }

  async registerScores(avatarId, scores) {
    Object.keys(scores).forEach(scoreKey => this.r.zadd(`${this.prefix}:scores:${scoreKey}`, scores[scoreKey], avatarId));
  }

  async incrLifetimeMetric(metricName, incrBy) {
    this.r.hincrby(`${this.prefix}:lifetime`, metricName, incrBy);
  }

  async getAllLifetimeMetrics() {
    const rkey = `${this.prefix}:lifetime`;
    const ltMetricKeys = await this.r.hkeys(rkey);
    let retVal = {};
    for (const ltKey of ltMetricKeys) {
      retVal[ltKey] = await this.r.hget(rkey, ltKey);
    }
    return retVal;
  }

  async queryHighScores(type, limit) {
    const avatarIdsToObjs = async (convList) => {
      let objList = [];
      for (let avId of convList) {
        if (Array.isArray(avId)) {
          objList.push((await avatarIdsToObjs(avId)));
        }
        else {
          let { name, species, scores } = await this.avatars(avId);
          objList.push({ name, species, scores });
        }
      }
      return objList;
    };

    return avatarIdsToObjs((await this.r.zrevrange(`${this.prefix}:scores:${type}`, 0, limit)));
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
    const worldKey = `${this.prefix}:worlds:${worldId}`;

    const bmXYInChunk = (rowWidth, x, y) => 
      [Math.floor(Number(x) / rowWidth), Math.floor(Number(y) / rowWidth)];

    const bmXYBitPos = (rowWidth, c, x, y) => 
      (Number(x) - (c[0] * rowWidth)) + ((Number(y) - (c[1] * rowWidth)) * rowWidth);

    const bmKey = (bmType, cX, cY) => `${worldKey}:bitmaps:${bmType}:${cX}:${cY}`;

    const bmChunkBitGetSet = async (bmType, cXcY, bitPos, setVal = undefined) => {
      let [cX, cY] = cXcY;
      if (setVal === undefined) {
        return this.r.getbit(bmKey(bmType, cX, cY), bitPos);
      } else {
        return this.r.setbit(bmKey(bmType, cX, cY), bitPos, Number(setVal));
      }
    };

    const bmGetSet = async (rowWidth, bmType, x, y, setVal = undefined) => {
      const chunk = bmXYInChunk(rowWidth, x, y);
      bmChunkBitGetSet(bmType, chunk, bmXYBitPos(rowWidth, chunk, x, y), setVal);
    };

    const bmListBlocksOfTypeInBoundingBox = async (rowWidth, bmType, fromX, fromY, toX, toY, strict = false) => {
      const _st = process.hrtime.bigint();
      const [fcX, fcY] = bmXYInChunk(rowWidth, fromX, fromY);
      const [tcX, tcY] = bmXYInChunk(rowWidth, toX, toY);
      let retList = [];

      for (let wcX = fcX; wcX <= tcX; wcX++) {
        for (let wcY = fcY; wcY <= tcY; wcY++) {
          let chunkBytes = await this.r.getBuffer(bmKey(bmType, wcX, wcY));

          if (!chunkBytes || chunkBytes.length < 1) {
            continue;
          }

          for (let cByte = 0; cByte < chunkBytes.length; cByte++) {
            for (let bit = 0; bit < 8; bit++) {
              if (chunkBytes[cByte] & (1 << bit)) {
                let ix = (wcX * rowWidth) + (7 - bit) + ((cByte % (rowWidth / 8)) * 8);
                let iy = ((((7 - bit) + (cByte * 8)) - ix + (wcX * rowWidth)) / rowWidth) + (wcY * rowWidth);
                retList.push([ix, iy]);
              }
            }
          }
        }
      }

      // strict includes only blocks within the specified bounding box and sorts them in CW order;
      // otherwise, all blocks within the *chunks* the specified bound box *hits* are included
      if (strict) {
        retList = retList.filter(x => x[0] >= fromX && x[1] >= fromY && x[0] <= toX && x[1] <= toY);
        // sort in clockwise order
        retList.sort((a, b) => {
          const xDiff = a[0] - b[0];
          if (xDiff === 0) {
            return a[1] - b[1];
          }
          return xDiff;
        });
      }

      this.log(`bmListBlocksOfTypeInBoundingBox(${rowWidth}, ${bmType}, ${fromX}, ${fromY}, ${toX}, ${toY}) ` +
        ` took ${Number(process.hrtime.bigint() - _st) / 1e6} ms`);
      return retList;
    };

    const bitmaps = { getSet: undefined };

    const gridGetSet = async (ggsWorldId, x, y, nObj, hasPlayerPresence) => {
      let gKey = `${worldKey}:grid`;
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

        let generatedItems = this.consItems.reduce((generated, chanceItem) => {
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
          if (chanceItem.modifiers) {
            const sStats = config.game.species[hasPlayerPresence].stats;
            if (chanceItem.modifiers.generate && chanceItem.modifiers.generate in sStats) {
              let genBoostStat = sStats[chanceItem.modifiers.generate];
              // gen boost allows a *max* of 5% boost to genChance with max genBoostStat
              let genBoost = (_x = Math.random()) * (0.05 / (config.game.meta.statMax / genBoostStat));
              this.log(`modifying ${genChance} with ${genBoost} -> ${genChance + genBoost} (stat=${genBoostStat}, rand=${_x})`);
              genChance += genBoost;
            }
          }

          if ('rarity' in chanceItem) {
            const rarityMod = config.game.meta.rarityTable[chanceItem.rarity-1];
            this.log(`item has rarity ${chanceItem.rarity}, adjusting ${genChance} down by ${rarityMod}%`);
            genChance *= 1 - (rarityMod / 100);
          }

          if (genChance > (_x = Math.random())) {
            this.log(`${genChance} > ${_x}, generating '${chanceItem.name}'!`);

            let rangeBoost = 0;
            if (chanceItem.modifiers && chanceItem.modifiers.range) {
              this.log(`modifying range based on ${chanceItem.modifiers.range} ` +
                `-> ${config.game.species[hasPlayerPresence].stats[chanceItem.modifiers.range]}`);
              let rangeBoostStat = config.game.species[hasPlayerPresence].stats[chanceItem.modifiers.range];
              rangeBoost = (1 + Math.random()) * (0.9 + (1 / (config.game.meta.statMax / rangeBoostStat)));
              this.log(`rangeBoost = ${rangeBoost} -> ${Math.ceil(rangeBoost)}`);
              rangeBoost = Math.ceil(rangeBoost);
            }

            let genStatFromRange = 1;
            if (chanceItem.range) {
              const rMin = chanceItem.range[0];
              const rMax = chanceItem.range[1] + rangeBoost;
              genStatFromRange = (Math.random() * (rMax - rMin)) + rMin;
              this.log(`genStatFromRange = ${genStatFromRange} [${rMin}, ${rMax}] -> ${Math.ceil(genStatFromRange)}`);
            }

            const newItem = { 
              type: 'item',
              payload: Object.assign({}, chanceItem, {
                stat: Math.ceil(genStatFromRange),
                id: uuid()
              }),
              localTs: Date.now()
            };

            this.log(`generated: ${JSON.stringify(newItem)}`);
            if (chanceItem.name === 'Breadcrumb Vending Machine') {
              this.incrLifetimeMetric('breadcrumb-vending-machines', 1);
            }
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
          this.incrLifetimeMetric('items-generated', generatedItems.length);
          nObj.inventory.push(...generatedItems);
        }
      }

      if (nObj) {
        // XXX TODO: this whole thing should be in the engine itself!
        // also, the following effectively 'hardcodes' terrian type
        // into the block object, and that's ultimately because this deferred
        // write ... really need to fix that.
        if (!('n' in nObj)) {
          const nWorld = await this.worlds(ggsWorldId);
          nObj.n = noise(x, y, nWorld);
        }

        let bTypes = config.game.block.types;
        nObj.type = bTypes[Object.keys(bTypes).sort()
            .find(bk => Number.parseFloat(bk) >= nObj.n)];

        if (hasPlayerPresence) {
          nObj.count = Number.parseInt((await this.r.hget(gKey, countKey))) + 1;
        }

        if (!('count' in nObj) || nObj.count === null) {
          nObj.count = 0;
        }

        if (!nObj.permanents) {
          nObj.permanents = {};
        }

        this.engine.submitWriteOp(() => {
          bitmaps.getSet('exists', x, y, true);
          ['tombstone', 'note', 'item'].forEach(chkType => {
            bitmaps.getSet(chkType, x, y, nObj.inventory.find(x => x.type === chkType) !== undefined);
          });
          this.r.hset(gKey, gField, JSON.stringify(nObj));
          this.r.hset(gKey, countKey, nObj.count);
          this.incrLifetimeMetric('blocks-changed', 1);
        });

        // XXX ugh, special cases are abounding...
        return hasPlayerPresence ? nObj : nObj.type;
      } else {
        let retVal = await getCurrentBlock();

        if (retVal) {
          let count = await (hasPlayerPresence ? this.r.hincrby(gKey, countKey, 1) : this.r.hget(gKey, countKey));
          retVal = { ...retVal, count };
        }

        return retVal;
      }
    };

    // form one, get world by id (one argument)
    // if DNE in redis, will return null
    if (worldId && !newWorld) {
      let rWorld = JSON.parse(await this.r.hget(worldKey, worldId));
      if (rWorld) {
        rWorld.grid = gridGetSet.bind(null, worldId);
        rWorld.bitmapsGetSet = bitmaps.getSet = bmGetSet.bind(null, rWorld.params.chunkRowWidth);
        rWorld.listBlocksOfTypeInBoundingBox = bmListBlocksOfTypeInBoundingBox.bind(null, rWorld.params.chunkRowWidth);
      }
      return rWorld;
    }

    let curWorlds = await this.r.hgetall(worldKey);

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

    newWorld.params.chunkRowWidth = config.redis.bitmaps.chunkRowWidth;

    this.log(`writing world ${worldId}:`);
    this.log(newWorld);

    return this.r.hset(worldKey, worldId, JSON.stringify(newWorld));
  }
};