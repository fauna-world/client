const config = require('config');
const moment = require('moment');
const uuid = require('uuid').v4;
const Cache = require('./cache');
const { NAME, manhattanDist, manhattanDistObj, scoreCatHeadings } = require('./util');

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
        newAvatar.inventory = [];
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
          curAvatar.scores['from-origin'] = manhattanDistObj(curAvatar.origin, curAvatar.loc);
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
              `<b>${curAvatar.scores['from-origin']}</b> blocks from where they began.`,
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

  async takeItemFromBlock(avatarId, worldId, x, y, itemId, condition, onFound) {
    let curAvatar = await this.cache.avatars(avatarId);
    let retVal = { success: false };

    if (!condition || !onFound) {
      return retVal;
    }

    try {
      if (curAvatar.life > 0 && condition(curAvatar)) {
        let world = await this.cache.worlds(worldId);
        let block = await world.grid(x, y);

        if (block.inventory.length) {
          let foundItem = block.inventory.find(itemCont => itemCont.payload.id === itemId).payload;
          if (foundItem) {
            // XXX: this whole thing should be atomic! (pipelined?)
            block.inventory = block.inventory.filter(itemCont => itemCont.payload.id !== itemId);
            await world.grid(x, y, block);

            const newAv = await onFound(curAvatar, foundItem);
            await this.avatars(avatarId, newAv);

            retVal.block = block;
            retVal.avatar = newAv;
            retVal.success = true;
          }
        }
      }
    } catch (err) {
      this.log(`takeItemFromBlock ERROR: ${err}`);
  }

    return retVal;
  }

  async consumeItem(avatarId, worldId, x, y, itemId) {
    return this.takeItemFromBlock(avatarId, worldId, x, y, itemId,
      (curAvatar) => curAvatar.consumeAllowed && curAvatar.life > 0,
      async (curAvatar, foundItem) => {
        this.cache.incrLifetimeMetric('life-gained-eating', foundItem.stat);
        this.cache.incrLifetimeMetric('items-eaten', 1);
        
        curAvatar.life += foundItem.stat;
        curAvatar.consumeAllowed--;

        return curAvatar;
      }
    );
  }


  async pickupItem(avatarId, worldId, x, y, itemId) {
    return this.takeItemFromBlock(avatarId, worldId, x, y, itemId,
      (curAvatar) => curAvatar.inventory.length !== config.game.meta.inventoryMax,
      async (curAvatar, foundItem) => {
        this.cache.incrLifetimeMetric('items-picked-up', 1);
        curAvatar.inventory.push(foundItem);
        return curAvatar;
      }
    );
  }

  async dropItem(avatarId, worldId, x, y, itemId) {
    let curAvatar = await this.cache.avatars(avatarId);
    let retVal = { success: false };

    if (curAvatar && curAvatar.life > 0) {
      let invItem = curAvatar.inventory.find(x => x.id === itemId);

      if (invItem) {
        let world = await this.cache.worlds(worldId);
        let block = await world.grid(x, y);

        block.inventory.push({
          type: 'item',
          payload: invItem,
          localTs: Date.now()
        });
        
        curAvatar.inventory = curAvatar.inventory.filter(x => x.id !== itemId);

        await world.grid(x, y, block);
        await this.avatars(avatarId, curAvatar);

        retVal.block = block;
        retVal.avatar = curAvatar;
        retVal.success = true;

        this.cache.incrLifetimeMetric('items-dropped', 1);
      }
    }

    return retVal;
  }

  async __findGardenspace(world, avatarId, startBlock) {
    this.log('\n\n-----\n-----\n----- __findGardenspace -----\n-----\n-----\n\n');
    this.log(`__findGardenspace(,, ${startBlock})`);
    const [curX, curY] = startBlock;
    const sparseMap = {};

    const vicMult = config.redis.bitmaps.chunkRowWidth * 2; // ?
    const vicinityBBox = () => [Math.max(0, curX - vicMult), Math.max(0, curY - vicMult), curX + vicMult, curY + vicMult];
    const atVicBBoxEdge = (northWest, southEast) => {
      const [lowX, lowY] = northWest;
      const [highX, highY] = southEast;

      return (lowX !== 0 && lowX === Math.max(1, curX - vicMult)) || 
            (lowY !== 0 && lowY === Math.max(1, curY - vicMult)) ||
            (highX === curX + vicMult) || (highY === curY + vicMult);
    };

    while (true) {
      const curVicBBox = vicinityBBox();
      const curVicinity = (await world.listBlocksOfTypeInBoundingBox('nest', ...curVicBBox)).concat(
        await world.listBlocksOfTypeInBoundingBox('gardenspace', ...curVicBBox));

      this.log(`curVicBBox=[${curVicBBox}]`);

      // first, simply mark all vicinity permanents in sparseMap *if* they belong to avatarId
      for (let block of curVicinity) {
        const [ix, iy] = block;
        if (!(ix in sparseMap)) {
          sparseMap[ix] = {};
        }

        if (!(iy in sparseMap[ix])) {
          sparseMap[ix][iy] = {};
        }

        const blockInfo = await world.grid(ix, iy);

        if (Object.values(blockInfo.permanents).some(x => x.owner === avatarId)) {
          sparseMap[ix][iy] = { contig: false, seen: false };
        }
      }

      // mark all blocks contiguous to (x, y)
      const markMapContig = (x, y) => {
        sparseMap[x][y].contig = sparseMap[x][y].seen = true;
        this.log(`markMapContig(${x}, ${y})`);
        
        for (let xPivot = x - 1; xPivot < x + 2; xPivot += 2) {
          this.log(`\t${xPivot} ${y}`);
          if (xPivot in sparseMap && y in sparseMap[xPivot] && !sparseMap[xPivot][y].seen) {
            markMapContig(xPivot, y);
          }
        }

        for (let yPivot = y - 1; yPivot < y + 2; yPivot += 2) {
          this.log(`\t${x} ${yPivot}`);
          if (x in sparseMap && yPivot in sparseMap[x] && !sparseMap[x][yPivot].seen) {
            markMapContig(x, yPivot);
          }
        }
      };

      this.log('sparseMap BEFORE:');
      this.log(JSON.stringify(sparseMap, null, 2));

      markMapContig(curX, curY);

      this.log('sparseMap AFTER:');
      this.log(JSON.stringify(sparseMap, null, 2));

      let lowX = 2e53, highX = -1, lowY = 2e53, highY = -1;

      Object.keys(sparseMap).forEach(ix => {
        Object.keys(sparseMap[ix]).forEach(iy => {
          if (!sparseMap[ix][iy].contig) {
            return;
          }

          if (ix < lowX) { lowX = ix; }
          if (ix > highX) { highX = ix; }
          if (iy < lowY) { lowY = iy; }
          if (iy > highY) { highY = iy; }
        });
      });

      const nw = [lowX, lowY];
      const se = [highX, highY];
      this.log(`OURS BB: (${nw}) - (${se})`); // XXX is *any/all* ours, not *contiguous* ours! must fix

      if (!atVicBBoxEdge(nw, se)) {
          this.log(`loooking good`);
          break;
        }

      this.log(`NEED MOAR!`);
      vicMult *= 2;
    }

    this.log('\n\n-----\n-----\n----- END __findGardenspace -----\n-----\n-----\n\n');
  }

  async findGardenspace(world, avatarId, curBlock, curList = undefined) {
    this.log(`findGardenspace(,, ${curBlock}, ${curList})`);
    const [curX, curY] = curBlock;

    // strict mode ensure the return list is sorted in clockwise order
    const curVicinity = await world.listBlocksOfTypeInBoundingBox('nest', curX-1, curY-1, curX+1, curY+1, true);
    this.log(`curVic: ${curVicinity}`);

    if (!curList) {
      curList = [];
    }

    curList.push(curBlock);

    if (curVicinity.length > 0) {
      for (const nextNest of curVicinity) {
        const [nX, nY] = nextNest;

        // directly adjacent (no corners)
        if (!(nX === curX || nY === curY)) {
          continue;
        }

        // must have at least four blocks to make a square! and if the next
        // block is the same as the origin block, we've enclosed a gardenspace!
        // this is the bottoming-out case
        if (curList.length >= 4 && curList[0][0] === nX && curList[0][1] === nY) {
          this.log(`FULL CIRCLE!! findGardenspace(,, ${curBlock}, ${curList})`);
          return curList;
        }

        // anything in curList cannot be revisted
        if (curList.some(x => x[0] === nX && x[1] === nY)) {
          this.log(`skipping ${nextNest}; it's in the curList!`);
          continue;
        }

        const nextNestBlock = await world.grid(nextNest[0], nextNest[1]);

        // if the next block isn't owned by us it's a dead end
        if (nextNestBlock.permanents.nest && nextNestBlock.permanents.nest.owner !== avatarId) {
          this.log(`${nextNest} is owned by someone else! NO GARDENSPACE FOR YOU`);
          return null;
        }

        this.log(`${nextNest} has a nest we own! RECURSE`);

        // must *copy* curList to ensure failed recursive calls don't add irrelevant blocks
        const nextList = await this.findGardenspace(world, avatarId, nextNest, [...curList]);
        
        // all frames except the base case return here
        if (nextList) {
          this.log(`WIN!! findGardenspace(,, ${curBlock}, ${curList}) -> ${nextList}`);
          return nextList;
        }
      }
    }

    this.log(`NOPE-- findGardenspace(,, ${curBlock}, ${curList})`);
    return null;
  }

  allBlockWithinGardenSpace(gsList) {
    let lowestY;
    let retList = [];
    const maxY = gsList.reduce((a, x) => x[1] > a[1] ? x : a, [null, -1])[1];
    this.log(`allBlockWithinGardenSpace maxY = ${maxY}`);

    while (true) {
      if (!lowestY) {
        lowestY = gsList.reduce((a, x) => x[1] < a[1] ? x : a, [-1, 2e32]);
      }

      this.log(`allBlockWithinGardenSpace lowestY = ${lowestY}`);

      let lowestXofLowestY = gsList.reduce((a, x) => x[1] === a[1] && x[0] < a[0] ? x : a, [2e32, lowestY[1]]);
      let highestXofLowestY = gsList.reduce((a, x) => x[1] === a[1] && x[0] > a[0] ? x : a, [-1, lowestY[1]]);

      if (lowestXofLowestY[0] === 2e32 || highestXofLowestY[0] === -1) {
        this.log(`huh ${lowestXofLowestY} to ${highestXofLowestY}`);
        break;
      }

      this.log(`allBlockWithinGardenSpace: row from ${lowestXofLowestY} to ${highestXofLowestY}`)
      for (let iX = lowestXofLowestY[0]; iX <= highestXofLowestY[0]; iX++) {
        retList.push([iX, lowestY[1]]);
      }

      lowestY[1] += 1;

      if (lowestY[1] > maxY) {
        break;
      }
    }

    return retList;
  }

  async createAt(avatarId, worldId, x, y, payload) {
    let curAvatar = await this.cache.avatars(avatarId);
    let retVal = { success: false };
    let world = await this.cache.worlds(worldId);
    let block = await world.grid(x, y);

    if (curAvatar && curAvatar.life > 0 && world && block) {
      const buildSpec = config.game.create[payload];

      if (buildSpec && buildSpec.requires) {
        let used = [];
        let good = true;
        
        for (const curSpecKey of Object.keys(buildSpec.requires)) {
          let curReq = buildSpec.requires[curSpecKey];
          const filtInv = curAvatar.inventory.filter(i => 
            i.type === 'raw_material' && i.affect === curSpecKey); 
          
          // determine if the player has enough raw_material in their inventory
          for (const item of filtInv) {
            if (item.stat && curReq) {
              if (item.stat <= curReq) {
                curReq -= item.stat;
                used.push(item);
              } else {
                item.stat -= curReq;
                curReq = 0;
              }
            }

            if (curReq === 0) {
              break;
            }
          }

          if (curReq > 0) {
            good = false;
            break;
          }
        }

        if (good) {
          curAvatar.inventory = curAvatar.inventory.filter(i => 
            used.reduce((a, x) => a && x.id !== i.id, true));

          if (Object.entries(block.permanents).length === 0) {
            await world.bitmapsGetSet('permanent', x, y, true);
          }

          const creationObj = {
            owner: avatarId,
            created: Date.now()
          };

          block.permanents[payload] = Object.assign({ inventory: [] }, creationObj);

          this.cache.incrLifetimeMetric(payload + '-built', 1);
          Object.keys(buildSpec.requires).forEach(reqName => 
            this.cache.incrLifetimeMetric(reqName + '-used', buildSpec.requires[reqName]));

          await world.bitmapsGetSet(payload, x, y, true);
          await world.grid(x, y, block);

          if (payload === 'nest') {
            if (!('nests-built' in curAvatar.scores)) { curAvatar.scores['nests-built'] = 0; }
            curAvatar.scores['nests-built'] += 1;
            
            if (curAvatar.life < config.game.meta.lifeMax) {
              curAvatar.life = config.game.meta.lifeMax;
            }

            const _foob = await this.__findGardenspace(world, avatarId, [x, y]);
            const newGS = await this.findGardenspace(world, avatarId, [x, y]);
            this.log('gardenspace? ' + newGS);

            if (newGS && newGS.length) {
              let allGSBlocks;
              try {
                allGSBlocks = this.allBlockWithinGardenSpace(newGS);
                this.log(`allGSBlocks: ${allGSBlocks}`);
              
                this.cache.incrLifetimeMetric('gardenspaces', 1);
                this.cache.incrLifetimeMetric('gardenspace-blocks', allGSBlocks.length);
                if (!('gardenspaces' in curAvatar.scores)) { curAvatar.scores['gardenspaces'] = 0; }
                curAvatar.scores['gardenspaces'] += 1;
                if (!('gardenspace-blocks' in curAvatar.scores)) { curAvatar.scores['gardenspace-blocks'] = 0; }
                curAvatar.scores['gardenspace-blocks'] += allGSBlocks.length;

                for (const gsBlock of allGSBlocks) {
                  const [gsX, gsY] = gsBlock;
                  let gsBlockObj = await world.grid(gsX, gsY);

                  if (!gsBlockObj) {
                    gsBlockObj = {
                      count: 0,
                      inventory: [],
                      permanents: {}
                    };
                    this.log(`GS block (${gsX},${gsY}) not extant, creating`);
                  }

                  gsBlockObj.permanents['gardenspace'] = creationObj;
                  await world.grid(gsX, gsY, gsBlockObj);

                  await world.bitmapsGetSet('gardenspace', gsX, gsY, true);
                  await world.bitmapsGetSet('permanent', gsX, gsY, true);
                }
              } catch (err) {
                this.log(`ERR\n\n${err}\n\n`);
                throw err;
              }
            }
          }

          this.cache.registerScores(avatarId, curAvatar.scores);
          await this.avatars(avatarId, curAvatar);

          this.log(`${avatarId} created '${payload}' at (${x}, ${y}), consuming:` +
            used.map(u => `\n${u.name} +${u.stat} (${u.id})`));
          
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
    const _allowedTypes = Object.keys(scoreCatHeadings);

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
