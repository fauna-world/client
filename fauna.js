console.log(`config: ${JSON.stringify(config, null, 2)}`);

const dims = Object.assign({}, config.uiDefaults);
const bgs = {};
const chatLog = [];
let qs = {};
let canvas = null;
let cclick = false;
let mapReady = false;
let mapLocked = false;
let connected = false;
let curMap;
let worldId;
let avatarId;
let avatar;
let gameCfg;
let speciesSpec;
let gameMeta;
let avatarLoc = { cur: undefined, prev: undefined };
let loadingScr = { e: undefined, p: undefined };
let preloads = {};
let mapLocs = {};
let mapLocsPerm = {};

const _hiliteCell = (origFill, hiliteFactor = 1.05) => origFill.map(x => x * hiliteFactor);
const _loliteCell = (origFill, hiliteFactor = 1.15) => origFill.map(x => x / hiliteFactor);
const _tintCell = (origFill, tintArr) => origFill.map((x, i) => x + tintArr[i]);

const _grayCell = (origFill) => {
  let avg = origFill.reduce((a, x) => a + x, 0) / origFill.length;
  return [avg, avg, avg];
}

const _borderCell = (origFill, borderColor = [255, 0, 0], borderWidth = 1) => {
  strokeWeight(borderWidth);
  stroke(borderColor);
  return origFill;
};

if (location.search) {
  qs = location.search.replace('?', '').split('&').map(x => x.split('=')).reduce((a, x) => { 
    a[x[0]] = x[1];
    return a;
  }, {});

}

if (location.hostname.indexOf('dev.') === 0) {
  qs.debug = true;
}

const debugAppendMsg = (msg) => { if ('debug' in qs) { select('#howbox').html(select('#howbox').html() + `<pre>${msg}</pre>`); } };

const debugAppendObj = (obj) => debugAppendMsg(JSON.stringify(obj, null, 2));

// w/o body is GET, with is POST
const faunaFetch = async (stub, body) => {
  let opts = {};

  if (body) {
    opts.method = 'POST';
    opts.headers = { 'Content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  } else {
    opts.method = 'GET';
  }

  let res = await fetch(`${config.host}/${stub}`, opts);
  let ret = await res.json();

  if (res.status !== 200) {
    console.log(ret);
    debugAppendObj(ret);
    throw new Error('faunaFetch');
  }


  if (ret.error) {
    throw new Error('faunaFetch server');
  }

  delete ret.error;
  return ret;
}

const apiCheck = async () => {
  try {
    let res = await fetch(`${config.host}/ping`);
    let text = await res.text();
    if (text.match(/^[\d\.]+$/) !== null) {
      gameCfg = await faunaFetch('gamecfg');
      speciesSpec = gameCfg.species;
      gameMeta = gameCfg.meta;

      if (!worldId && gameMeta.defaultWorldParams) {
        Object.keys(gameMeta.defaultWorldParams).forEach(dk => {
          dims[dk] = gameMeta.defaultWorldParams[dk];
        });

        qs['enterImmediate'] = true;
      }

      connected = true;
      return text;
    }
  } catch (err) {
    console.log(`Failed to connect to Fauna server: ${err}`);
  }
  return null;
};

Object.keys(dims).forEach(dk => {
  if (dk in qs) {
    dims[dk] = Number(qs[dk]);
  }
});

if ('debug' in qs) {
  config.uiMultipliers.height *= 0.90;
}

if ('worldId' in qs) {
  worldId = qs.worldId;
}

const showNoise = (x, y) => noise(x * dims.scale, y * dims.scale);

const colorXform = (noiseVal) => {
  const breaks = {
    0.2: (_, invNv) => [0, 64 * invNv, 192 * invNv],
    0.4: (nv, invNv) => [128 - (64 * invNv), 212 * invNv, 92 * nv],
    0.6: (_, invNv) => [255 - (128 * invNv), 255 - (92 * invNv), 255 - (192 * invNv)],
    0.8: (nv, invNv) => [255 * nv, 255 * nv, 255 * nv * (1.1 * invNv)]
  };

  let bk = Object.keys(breaks).sort().find(bk => noiseVal < Number.parseFloat(bk));
  return bk ? breaks[bk](noiseVal, ((1 / Number.parseFloat(bk)) * noiseVal)) : Array(3).fill(noiseVal * 255);
};

const _renderDebounceTime = 100;
let _renderDebounce;
let _lastSelLoc;
let _origCellFill;
let _refreshGSBuffer = [];

const refreshVisible = async (bb) => {
  const typeList = config.filters.permanents.concat(config.filters.items);
  const q = `world/${worldId}/blocks/${typeList.join(',')}/inbb/${bb.from.x}/${bb.from.y}/${bb.to.x}/${bb.to.y}`;
  let qresp = await faunaFetch(q);

  mapLocs = {};

  Object.keys(qresp).forEach((typeKey) => {
    let mlRef = config.filters.permanents.find(x => x === typeKey) ? mapLocsPerm : mapLocs;

    qresp[typeKey].forEach(ts => {
      let imgRef = typeKey;

      if (typeKey === 'gardenspace') {
        if (_refreshGSBuffer.length === 0) {
          for (let i = 0; i < config.gs.numImgs; i++) {
            _refreshGSBuffer.push(`gardenspace_${i}`);
          }
      
          // very simple shuffle
          for (let i = 0; i < config.gs.numImgs * config.gs.shufPasses; i++) {
            const ii = i % config.gs.shufPasses;
            let Ri = Math.floor(Math.random() * config.gs.numImgs);
            const tmp = _refreshGSBuffer[ii];
            _refreshGSBuffer[ii] = _refreshGSBuffer[Ri];
            _refreshGSBuffer[Ri] = tmp;
          }
        }

        imgRef = _refreshGSBuffer.shift();
      }

      const mlStr = `${ts[0]},${ts[1]}`;

      if (!(mlStr in mlRef)) {
        mlRef[`${ts[0]},${ts[1]}`] = preloads[`${imgRef}.png`];
      }
    });
  });

  mapLocs = Object.assign(mapLocs, mapLocsPerm);

  render(true);
};

const render = (fromRefresher = false) => {
  if (!mapReady) {
    return;
  }

  let rd = { w: dims.w / dims.res, h: dims.h / dims.res };

  clearTimeout(_renderDebounce);
  if (!fromRefresher) {
    _renderDebounce = setTimeout(() => {
      refreshVisible({ 
        from: { x: -dims.xoff, y: -dims.yoff }, 
        to: { x: Math.ceil(rd.w - dims.xoff), y: Math.ceil(rd.h - dims.yoff) }
      });
    }, _renderDebounceTime);
  }

  clear();
  noiseDetail(dims.lod, dims.falloff);
  noiseSeed(dims.seed);

  curMap = [];
  for (let x = 0; x < rd.w; x++) {
    if (curMap[x] === undefined) {
      curMap[x] = [];
    }

    for (let y = 0; y < rd.h; y++) {
      let mapCoords = [x - dims.xoff, y - dims.yoff];
      curMap[x][y] = showNoise(mapCoords[0], mapCoords[1]);
      let mapCoordStr = `${mapCoords[0]},${mapCoords[1]}`;
      let fillOrig = colorXform(curMap[x][y]);
      let fillObj = fillOrig;

      if (mapCoordStr in mapLocs) {
        let luFill = mapLocs[mapCoordStr];
        fillObj = typeof luFill === 'function' ? luFill(mapCoords, fillObj) : luFill;
        if (typeof fillObj === 'function') {
          fillObj = fillObj(mapCoords, fillObj);
        }
      }

      let properDims = [x * dims.res, y * dims.res, dims.res, dims.res];

      if (_lastSelLoc && _lastSelLoc.length) {
        let _lsSplit = _lastSelLoc.split(',');
        // TODO: should probably remove wierd multi-function fill set in
        // setSelectedLocation() below and *just* use this!
        if (_lsSplit[0] == mapCoords[0] && _lsSplit[1] == mapCoords[1]) {
          _borderCell(null, config.uiDefaults.boxSelectBorderColor);
        }
      }

      if (avatarLoc && avatarLoc.cur && avatarLoc.cur.x === mapCoords[0] && avatarLoc.cur.y === mapCoords[1]) {
        fillObj = preloads[`${avatar.species}.png`];
      }

      if (Array.isArray(fillObj)) {
        fill(...fillObj);
        rect(...properDims);
      } else if (typeof fillObj === 'object') {
        fill(...fillOrig);
        rect(...properDims);
        image(fillObj, ...properDims);
      } else {
        console.log(fillObj);
        throw new Error(`^^^ unknown fill obj! ${properDims}`);
      }

      noStroke();
    }
  }
};

const updateAvatarInfo = async (x, y, block) => {
  let statsDiv = select('#avatarstatsdiv');
  let html = '<table id="avstattable">';
  html += '<tr><td class="avstatname">Block:</td>';
  html += `<td class="avstatstat">(${x}, ${y})</td></tr>`;
  html += `<tr><td class="avstatname">Life:</td>`;
  html += `<td class="avstatstat">${avatar.life}</td>`;
  html += `<tr><td class="avstatname">Flown:</td>`;
  html += `<td class="avstatstat">${avatar.scores.moved}</td>`;
  html += `</tr></table>`;
  statsDiv.html(html);
  statsDiv.style('display', 'block');

  if (avatar.inventory.length > 0) {
    let woodAmt = 0;
    const avInvTable = select('#avinvtable');
    avInvTable.html('');

    avatar.inventory.forEach((item) => {
      const idStub = item.id.substring(0, 8);
      const tRow = createElement('tr');
      tRow.parent(avInvTable);

      const baseTds = ['name', 'stat', 'affect', 'drop'].reduce((aHash, iType) => {
        const tdItem = createElement('td');
        tdItem.class = 'avinv_' + iType;
        tdItem.elt.id = `tditem_${iType}_${idStub}`;
        if (iType in item) {
          tdItem.html(iType === 'name' ? getItemSig(item) : item[iType]);
        }
        tdItem.parent(tRow);
        aHash[iType] = tdItem;
        return aHash;
      }, {});

      baseTds.stat.html(`<b>+${baseTds.stat.html()}</b>`);

      baseTds.drop.elt.id = `td_avdrop_${idStub}`;
      attachButtonForItem(item, baseTds.drop, x, y, 'drop_inventory');

      woodAmt += item.affect === 'wood' ? item.stat : 0;
    });

    const tr = createElement('tr');
    tr.parent(avInvTable);
    let td = createElement('td');
    td.elt.colSpan = 2;
    td.parent(tr);
    td.html('&nbsp;');

    if (woodAmt >= gameCfg.create.nest.requires.wood) {
      if (!block && worldId) {
        const resp = await blockLoader(worldId, x, y);
        if (resp) {
          block = resp.block;
        }
      }

      if (block && Object.entries(block.permanents).length === 0) {
        const mnBut = createElement('a', 'Build Nest');
        mnBut.elt.href = '#';
        mnBut.elt.onclick = async () => {
          await avatarActionOnClickHandler(x, y, null, 'create', 'nest');
        };

        const sT = createElement('span');
        sT.class('tooltip');

        td.html('');
        sT.parent(td);
        mnBut.parent(sT);

        const sTTxt = createElement('span');
        sTTxt.class('tooltiptext tooltip_bot2');
        sTTxt.html(`Requires <u>${gameCfg.create.nest.requires.wood}</u> wood`);
        sTTxt.parent(sT);
      }
    }

    td = createElement('td');
    td.elt.colSpan = 2;
    td.parent(tr);

    const dropAll = createElement('a', 'Drop All');
    dropAll.elt.href = '#';
    dropAll.elt.onclick = async () => {
      for (let invItem of avatar.inventory) {
        await avatarActionOnClickHandler(x, y, invItem.id, 'drop');
      }
    };
    dropAll.parent(td);
  }

  select('#avatarinvtable').style('display', avatar.inventory.length > 0 ? 'block' : 'none');
}

const setAvatarLoc = async (x, y, uiOnly = false) => {
  const newLoc = `${x},${y}`;

  if (avatarLoc.prev) {
    mapLocs[avatarLoc.prev.loc] = avatarLoc.prev.fill;
  }

  if (newLoc in mapLocs && newLoc !== _lastSelLoc) {
    avatarLoc.prev = {
      loc: newLoc,
      fill: mapLocs[newLoc]
    };
  }

  let setBlock
  if (!uiOnly) {
    setBlock = await faunaFetch(`avatar/${avatarId}/loc`, { worldId, x, y });

    if (!setBlock.success) {
      alert('Your life is not high enough to move this far!');
      return;
    }
  }

  if (uiOnly || (setBlock.block && setBlock.avatar)) {
    if (avatarLoc.cur) {
      const curLocStr = `${avatarLoc.cur.x},${avatarLoc.cur.y}`
      avatarLoc.prev = { loc: avatarLoc.cur, fill: mapLocs[curLocStr] };
    }

    if (!uiOnly) {
      avatar = setBlock.avatar;
    }

    avatarLoc.cur = { x, y };
    mapLocs[newLoc] = preloads[`${avatar.species}.png`];

    await updateAvatarInfo(x, y, setBlock ? setBlock.block : undefined);
    render();

    if (avatar.life === 0) {
      avatarLoc = undefined;
      alert(`You have perished after flying a distance of ${avatar.scores.moved} blocks, ` +
        `${avatar.scores['from-origin']} blocks from where you began.` + '\n\nPlease click "RESET!" to begin anew.');
    }

    return !uiOnly ? setBlock.block : null;
  }
}

const setSelectedLocation = (x, y) => {
  const newLoc = `${x},${y}`;

  if (_lastSelLoc) {
    if (_origCellFill) {
      mapLocs[_lastSelLoc] = _origCellFill;
      _origCellFill = null;
    } else if (typeof mapLocs[_lastSelLoc] === 'function') {
      delete mapLocs[_lastSelLoc];
    }
  } else if (newLoc === _lastSelLoc) {
    return;
  }

  const renderFunc = (_, origFill) => _borderCell(origFill, config.uiDefaults.boxSelectBorderColor);

  if (newLoc in mapLocs) {
    _origCellFill = mapLocs[newLoc];
    if (typeof _origCellFill === 'function') {
      mapLocs[newLoc] = (c, oFill) => renderFunc(c, _origCellFill(c, oFill));
    } else {
      mapLocs[newLoc] = renderFunc.bind(null, null, _origCellFill);
    }
  } else {
    mapLocs[newLoc] = renderFunc;
  }

  _lastSelLoc = newLoc;
  render();
}

const updateChatBox = () => {
  const rxTimeStr = (m) => {
    const _ps = (s) => String(s).padStart(2, '0');
    return `${_ps(m.rxTime.getHours())}:${_ps(m.rxTime.getMinutes())}:${_ps(m.rxTime.getSeconds())}<br/>${m.rxTime.toLocaleDateString()}`;
  };

  const formatChatMsg = (x) => {
    return `&lt;<span class='chatusername tooltip'>` +
      `<span class='tooltiptext tooltip_top'>${rxTimeStr(x)}</span>` +
      (x.from.species ? `<img src='assets/${x.from.species}.png' class='chatimg'/>` : '') + 
      `${x.from.name}</span>&gt; ${x.payload}`;
  };
  
  select('#chatmain').html(chatLog.slice(-dims.chatHist).map(formatChatMsg).join('<br/>'));
};

const gs = (key, allow, cb, val) => {
  if (val !== undefined) {
    if (dims[key] !== val && allow(val)) {
      dims[key] = val;
      let e = select('#ins_' + key);
      if (e) {
        e.value(val);
        if (!(key in bgs)) {
          let origBg = e.elt.style.backgroundColor;
          e.elt.style.backgroundColor = '#ad925f';

          bgs[key] = setTimeout(() => { 
            e.elt.style.backgroundColor = origBg; 
            delete bgs[key]; 
          }, 1000);

          if (cb) {
            cb(val);
          }
        }
      }
      return true;
    }
    return false;
  }
  return dims[key];
};

const allow_any = (_) => true;
const allow_pos = (v) => v > 0;
const allow_pos_offs = (v) => v <= 0;

const ins = {
  xoff: gs.bind(null, 'xoff', allow_pos_offs, null),
  yoff: gs.bind(null, 'yoff', allow_pos_offs, null),
  res: gs.bind(null, 'res', (v) => v >= 10 && (v % 2) === 0, null),
  scroll: gs.bind(null, 'ss', allow_pos, null),
  scrollStep: gs.bind(null, 'scrollStep', allow_pos, null),
  seed: gs.bind(null, 'seed', allow_any, null),
  scale: gs.bind(null, 'scale', allow_any, null),
  lod: gs.bind(null, 'lod', (v) => v >= 1 && v <= 8, null),
  falloff: gs.bind(null, 'falloff', (v) => v >= 0.0 && v <= 1.0, null),
  chatHist: gs.bind(null, 'chatHist', (v) => v >= 1 && v <= 40, updateChatBox)
};

const insLock = ['seed', 'scale', 'lod', 'falloff'];

let heldHandle;

function keyPressed() {
  if (!mapReady) {
    return true;
  }

  const scrollAdd = () => dims.scrollStep;
  const scaleAdd = () => dims.scaleStep;
  const km = {
    [UP_ARROW]: () => ins.yoff(dims.yoff + scrollAdd()),
    [DOWN_ARROW]: () => ins.yoff(dims.yoff - scrollAdd()),
    [LEFT_ARROW]: () => ins.xoff(dims.xoff + scrollAdd()),
    [RIGHT_ARROW]: () => ins.xoff(dims.xoff - scrollAdd()),
    '_': ins.scale ? () => ins.scale(dims.scale + scaleAdd()) : null,
    '+': ins.scale ? () => ins.scale(dims.scale - scaleAdd()) : null,
    'f': ins.falloff ? () => ins.falloff(dims.falloff + 0.01) : null,
    'F': ins.falloff ? () => ins.falloff(dims.falloff - 0.01) : null,
    'l': ins.lod ? () => ins.lod(dims.lod + 1) : null,
    'L': ins.lod ? () => ins.lod(dims.lod - 1) : null,
    '[': () => ins.res(dims.res - 2),
    ']': () => ins.res(dims.res + 2)
  };

  let rKey = keyCode;
  if (rKey in km || ((rKey = key) && rKey in km)) {
    if (km[rKey] === null) {
      return true;
    }

    const _ex = () => {
      km[rKey]();
      render();
    };

    const _sch = () => { heldHandle = setTimeout(_toex, dims.ss); };
    const _toex = () => { if (heldHandle) { _sch(); _ex(); } };

    _sch();
    _ex();
    return false;
  }
}

function keyReleased() {
  clearTimeout(heldHandle);
  heldHandle = undefined;
  return false;
}

function windowResized(evnt) {
  dims.w = Math.round(windowWidth * config.uiMultipliers.width);
  dims.h = Math.round(windowHeight * config.uiMultipliers.height);
  if (evnt !== null) {
    resizeCanvas(dims.w, dims.h, true);
    render();
  }
}

const persistAv = () => avatarId ? `${config.cookieName}=${avatarId}` : '';
const persistQs = () => `worldId=${worldId}`;
const persistUrl = (avatar = false) => `/?` + (avatar ? persistAv() : persistQs());

async function fetchAvatar(avatarId) {
  let avRes = await faunaFetch(`avatar/${avatarId}`);

  if (Object.keys(avRes).length === 0) {
    return null;
  }

  avatar = avRes.avatar;

  if (avatar === null) {
    console.log(`bad (old?) avatar id ${avatarId}; removing`);
    document.cookie = `${config.cookieName}=${avatarId};expires=Thu, 01 Jan 1970 00:00:01 GMT`;
  }
  return avatar;
}

async function loadAvatar() {
  if (!avatar) {
    avatar = await fetchAvatar(avatarId);
  }

  let avbox = select('#avbox');
  let imgFileName = `${avatar.species}.png`;

  avbox.html(
    '<table class="avtable"><tr><td class="avtablecell">' +
    `<a href='${persistUrl(true)}'>` +
    `<img src='assets/${imgFileName}' class='speciesavatar' /></a>` +
    `<div class='speciesname'>${avatar.name}</div>` +
    '</td><td class="avtablecell">' + 
    '<div id="avatarstatsdiv" class="dispnone"></div>' +
    '</td></tr><tr><td colspan="2"><div id="avatarinvtable" class="dispnone">' +
    '<h5><u>Inventory</u></h5>' +
    '<table id="avinvtable">' +
    '</table>' +
    '</div>');

  avbox.elt.style.display = 'block';

  if (avatar.loc) {
    await setAvatarLoc(avatar.loc.x, avatar.loc.y, true);
  }
}

let lm_backoff = 0;
let lm_handle;
async function loadMessaging(reconnect = false) {
  if ('debug' in qs) { console.log(`loadMessaging(${reconnect}), bo=${lm_backoff}`); }
  let wsConn = new WebSocket(`${config.msgHost}/?${config.cookieName}=${avatarId}` + 
    (reconnect ? '&rc=1' : ''));
  ++lm_backoff;

  let chatbox = select('#chatbox');
  let sendBut = select('#chatsend');
  let sendTxt = select('#chattext');
  chatbox.style('display', 'block');

  wsConn.addEventListener('open', () => {
    lm_backoff = 0;
    clearTimeout(lm_handle);
    const fromObj = Object.assign({}, avatar, { id: avatarId });
    const heartbeat = () => {
      wsConn.send(JSON.stringify({
        type: 'heartbeat',
        localTs: Date.now()
      }));
      lm_handle = setTimeout(heartbeat, config.heartbeat * 1000);
    };
    
    heartbeat();

    const _sendMsg = () => {
      let chkVal = sendTxt.value().trim();
      if (chkVal.length) {
        wsConn.send(JSON.stringify({
          type: 'chat',
          payload: chkVal,
          from: fromObj,
          localTs: Date.now(),
          to: 'global'
        }));
      }
      sendTxt.value('');
    };

    sendTxt.elt.disabled = false;
    sendTxt.value('');
    sendTxt.elt.onkeydown = (keyEv) => {
      if (keyEv.key === 'Enter') {
        _sendMsg();
      }
    };

    sendBut.elt.disabled = false;
    sendBut.elt.onclick = _sendMsg;
  });

  const _seasons = gameCfg.block.seasons;
  wsConn.addEventListener('message', (event) => {
    try {
      let msgObj = JSON.parse(event.data);

      if (msgObj.type === 'chat') {
        msgObj.rxTime = new Date();
        chatLog.push(msgObj);
        updateChatBox();
      } else if (msgObj.type === 'gametime') {
        select('#gameclock').style('display', 'block');
        let gameDate = new Date(msgObj.payload.time);
        const season = _seasons[gameDate.getMonth()];
        const boostsRev = Object.keys(gameCfg.block.boosts).reduce((acc, oKey) => ({ 
          [gameCfg.block.boosts[oKey]]: oKey[0].toUpperCase() + oKey.substring(1), ...acc 
        }), {});
        const blockPref = boostsRev[season.toLowerCase()];
        const thConj = blockPref[blockPref.length - 1] === 's' ? '' : 's';
        select('#gameclock').html(
          `<span class='tooltip'><span class='tooltiptext tooltip_bot'>` +
          ` <b>${boostsRev[season.toLowerCase()]}</b> thrive${thConj} in ${season}</span>` +
          season + ' ' + 
          `${String(gameDate.getFullYear()).padStart(4, '0')}</span>` +
          '<img src="assets/clock.png" width=24 style="margin-right: 5px; margin-left: 10px;"/>'
        );
      } else if (msgObj.type === 'reconnect') {
        console.log(`successful reconnect at ${(new Date(msgObj.localTs)).toISOString()} (${(new Date()).toISOString()})`);
      }
    } catch (err) {
      console.log(`bad msg rx'ed! ${event.data}:`);
      console.log(err);
    }
  });

  const showReconnDisp = () => {
    sendTxt.elt.disabled = true;
    sendTxt.value('reconnecting...');
    sendBut.elt.disabled = true;
    select('#gameclock').html('???');
  };

  wsConn.addEventListener('close', (ev) => {
    clearTimeout(lm_handle);
    let waitMs = 2 ** lm_backoff;
    console.log(`close ${ev.code}, trying to reconnect ${(new Date()).toISOString()}... (waiting ${waitMs}ms)`);
    if (ev.code !== 1006 && ev.code !== 1001) {
      console.log(ev);
    }

    showReconnDisp();
    setTimeout(loadMessaging.bind(null, true), waitMs);
  });

  wsConn.addEventListener('error', (err) => {
    console.log(`ws err!`);
    console.log(err);
    showReconnDisp();
  });

  window.onclose = () => {
    wsConn.close();
  }
}

const addConnectedUx = async () => {
  let worldBanner_d = createElement('div');
  let worldBanner = createElement('h2');
  worldBanner.elt.id = 'welcomesign';
  worldBanner.elt.style.display = 'none';

  select('#howbox').parent(worldBanner_d);
  worldBanner.parent(worldBanner_d);

  const goBut_d = createElement('div');
  const goButClicked = async () => {
    mapLocked = true;
    goBut_d.elt.style.display = 'none';

    select('body').elt.className = 'go';
    select('#chatform').style('display', 'block');

    const fetchExtantWorld = async (worldId) => {
      let jres = await faunaFetch(`world/${worldId}`);
      if (!jres) {
        throw new Error('unknown world!');
      }
      else {
        Object.keys(jres.world.params).forEach(dimKey => dims[dimKey] = jres.world.params[dimKey]);
        console.log(`extant world found '${jres.world.name}' (${worldId})`);
        render();
        return jres;
      }
    };

    let jres;
    const wSpec = {};
    insLock.forEach(inLock => {
      let e = select('#ins_' + inLock);
      e.elt.disabled = true;
      ins[inLock] = null;
      wSpec[inLock] = e.value();
    });

    if (avatar && avatar.loc) {
      worldId = avatar.loc.worldId;
      dims.xoff = -avatar.loc.x;
      dims.yoff = -avatar.loc.y;
      console.log(`avatar found @ (${avatar.loc.x}, ${avatar.loc.y})`);
      jres = await fetchExtantWorld(worldId);
    }
    else {
      if (!worldId) {
        jres = await faunaFetch(`world/enter`, wSpec);
        worldId = jres.worldId;
      }
      else {
        jres = await fetchExtantWorld(worldId);
      }
    }

    console.log(`Entering world "${jres.world.name}" (${worldId})`);
    select('#howbox').html("arrow keys scroll, square brackets zoom" + 
      ('debug' in qs ? `<br/><br/>"${jres.world.name}" (${worldId})` : ''));
    worldBanner.html("<span style='font-size: 65%;'><a href='/?faunaAvatar=null'>RESET!</a></span>");
    worldBanner.elt.style.display = 'block';
    if (jres.isNew) {
      worldBanner.elt.style.fontStyle = 'oblique';
    }

    await loadAvatar();
    loadMessaging();
  };

  if (avatar && !avatar.loc && !('enterImmediate' in qs || 'worldId' in qs)) {
    createElement('br').parent(goBut_d);
    const goBut = createElement('input');
    goBut.parent(goBut_d);
    goBut.elt.type = 'submit';
    goBut.elt.style.width = '150px';
    goBut.elt.value = 'Enter World!'; 
    goBut.mouseClicked(goButClicked);
    createElement('br').parent(goBut_d);
  } else {
    await goButClicked();
  }
};

const updateItemIcon = (x, y, _items) => {
  const mlStr = `${x},${y}`;
  if (_items.length > 0 && !mapLocs[mlStr]) {
    mapLocs[mlStr] = preloads['item.png'];
  } else if (_items.length === 0 && mapLocs[mlStr]) {
    delete mapLocs[mlStr];
  }
};

const buttonsSpec = {
  consumable: {
    title: 'Eat',
    type: 'input',
    subtype: 'submit',
    class: 'eatbut',
    action: 'consume',
    isDisabled: () => (avatar.consumeAllowed <= 0 || avatar.inventory.length > 0)
  },
  raw_material: {
    title: 'Pick up',
    type: 'input',
    subtype: 'submit',
    class: 'eatbut pickupbut',
    action: 'pickup',
    isDisabled: () => (avatar.inventory.length === gameCfg.meta.inventoryMax)
  },
  drop_inventory: {
    title: 'X',
    type: 'a',
    class: '',
    action: 'drop',
    isDisabled: () => (avatar.inventory.length === 0)
  }
};

async function avatarActionOnClickHandler(showX, showY, itemId, action, payload) {
  let req = { 
    worldId: worldId, 
    x: showX, 
    y: showY, 
    itemId: itemId,
    action: action
  };

  if (itemId) {
    req.itemId = itemId;
  }

  if (payload) {
    req.payload = payload;
  }

  let res = await faunaFetch(`avatar/${avatarId}/loc`, req);

  if (res.success) {
    avatar = res.avatar;
    updateItemIcon(showX, showY, res.block.inventory);
    updateAvatarInfo(showX, showY, res.block);
    setBlock(worldId, showX, showY, res);
  } else {
    debugAppendMsg('button error!');
    console.log('button error!');
  }
}

function attachButtonForItem(item, parentEle, showX, showY, overrideType) {
  let realType = item.type;
  if (overrideType) {
    realType = overrideType;
  }

  if (!(realType in buttonsSpec)) {
    console.log(`'${type} not spec'ed for buttonsSpec!`);
    return;
  }

  let bs = buttonsSpec[realType];

  let but;

  if (bs.type === 'input') {
    but = createInput(bs.title, bs.subtype);
  } else {
    but = createElement(bs.type, bs.title);
    if (bs.type === 'a') {
      but.elt.href = '#';
    }
  }
  
  but.parent(parentEle);
  but.class(bs.class);
  but.elt.id = `${realType.replace(/\s+/g, '').toLowerCase()}_${item.id.substring(0, 8)}`;

  but.elt.addEventListener('click', async () => {
    but.elt.disabled = true;
    await avatarActionOnClickHandler(showX, showY, item.id, bs.action);
  });

  but.elt.disabled = bs.isDisabled() || avatar.life <= 0 || 
    !(avatar.loc && avatar.loc.x === showX && avatar.loc.y === showY);

  return but;
}

const getItemSig = (item) => item.image ? 
        `<span class="tooltip"><img src="assets/${item.image}" alt="${item.name}" width="32" />` +
        `<span class="tooltiptext tooltip_top2">${item.name}</span>` : `"${item.name}"`;

const blockLoader = async (worldId, showX, showY) => {
  let rootQStr = `world/${worldId}/block/${showX}/${showY}`;
  return faunaFetch(`${rootQStr}`);
};

const setBlock = async (worldId, showX, showY, preloadedBlock) => {
  if (!preloadedBlock) {
    throw new Error('nope');
  }

  let res = preloadedBlock;
  const infBox = select('#infobox');

  infBox.html(`<span class="tooltip"><span class="tooltiptext tooltip_top2">(${showX}, ${showY})`+
    `</span><h3 style="font-variant: small-caps;">${res.block.type}</h3></span></br>` + 
    (res.block.count > 0 ? `<span style="font-variant: small-caps;">` +
      `<b>${res.block.count}</b> visitor${res.block.count == 1 ? '' : 's'}` : '') + '</span><br/>');

  if (res.block && res.block.permanents.nest) {
    const nestEle = createElement('div');
    const nestOwner = await faunaFetch(`avatar/${res.block.permanents.nest.owner}`);

    nestEle.html('<table style="width: 100%; margin-bottom: -5px;"><tr><td style="text-align: right">' +
      '<img src="assets/nest.png" width="100" /></td><td style="text-align: left">' +
      `Built by<br/><b>${nestOwner.avatar.name} the ${nestOwner.avatar.species}</b></br>on ` +
      `<b>${(new Date(res.block.permanents.nest.created)).toLocaleDateString()}` +
      '</td></tr></table>');

    nestEle.parent(infBox);
  }

  if (res.block && res.block.permanents.gardenspace) {
    const gsEle = createElement('div');
    const gsOwner = await faunaFetch(`avatar/${res.block.permanents.gardenspace.owner}`);

    gsEle.html('<table style="width: 100%; margin-bottom: -5px;"><tr><td style="text-align: right">' +
      '<img src="assets/gardenspace.png" width="75" style="margin-top: -25px;"/></td><td style="text-align: left">' +
      `Territory captured by<br/><b>${gsOwner.avatar.name} the ${gsOwner.avatar.species}</b></br>on ` +
      `<b>${(new Date(res.block.permanents.gardenspace.created)).toLocaleDateString()}` +
      '</td></tr></table>');

    gsEle.parent(infBox);
  }

  createElement('br').parent(infBox);

  let isCurrentAvatarLoc = false;

  if (avatarLoc) {
    let startBut = createElement('input');
    startBut.elt.id = 'beginbut';
    startBut.elt.type = 'submit';
    startBut.elt.onclick = async () => {
      startBut.elt.parentNode.removeChild(startBut.elt);
      setBlock(worldId, showX, showY, { block: await setAvatarLoc(showX, showY) });
    };

    if (!avatarLoc.cur) {
      startBut.elt.value = 'Begin the journey here!';
    }
    else if (!(isCurrentAvatarLoc = avatarLoc.cur.x === showX && avatarLoc.cur.y === showY) &&
      avatar.life > 0) {
      startBut.elt.value = 'Fly here';
    }

    if (startBut.value().length > 0) {
      startBut.parent(infBox);
    } else {
      startBut.remove();
    }
  }

  const itemsToRender = res.block.inventory.filter(x => x.type === 'item');

  // TODO: render as a table, too?
  if (itemsToRender.length) {
    const itemsDiv = createElement('div');
    itemsDiv.parent(infBox);
    itemsDiv.html('<u>Available items</u>:<br/>');
    itemsDiv.elt.id = 'itemsdiv';

    updateItemIcon(showX, showY, itemsToRender);
    itemsToRender.forEach(itemCont => {
      let item = itemCont.payload;
      const itemDiv = createElement('div');
      itemDiv.parent(itemsDiv);

      attachButtonForItem(item, itemDiv, showX, showY);

      let itemSpan = createElement('span');
      itemSpan.parent(itemDiv);
      itemSpan.html(`&nbsp;${getItemSig(item)} &mdash; <b>+${item.stat}</b> ${item.affect}`);
    });
    
    createElement('br').parent(itemsDiv);
  }

  let notesItems = res.block.inventory.filter(x => x.type === 'note');
  let notesCount = notesItems.length;
  let notesAdded = 0;
  let noteParent = infBox;
  if (notesCount > 0) {
    noteParent = createElement('table');
    noteParent.elt.style.width = '100%';
    noteParent.parent(infBox);
    let header = createElement('tr').parent(noteParent);
    let hRow = createElement('td').parent(header);
    hRow.elt.colSpan = '2';
    hRow.html(`<u>${notesCount} notes:</u>`);
  }

  notesItems.forEach(invItem => {
    if (invItem.type === 'note') {
      ++notesAdded;
      let _s = createElement('tr');
      _s.parent(noteParent);
      let _ss = createElement('td').parent(_s);
      _ss.html(`<span class='invitem-small'>A ${invItem.poster.species} ` + 
        `named ${invItem.poster.name} said:</span><br/>` + 
        `<span class='invitem-reg'>"${invItem.payload}"</span><br/>`);
    }
  });

  if (notesAdded > 0) {
    createElement('br').parent(infBox);
  }

  if (isCurrentAvatarLoc) {
    const submitNote = () => {
      const { name, species } = avatar;
      faunaFetch(`world/${worldId}/block/${showX}/${showY}/add`, {
        type: 'note',
        payload: noteText.value(),
        poster: Object.assign({ name, species }, { id: avatarId })
      }).then(() => {
        setTimeout(async () => {
          const nBlock = await blockLoader(worldId, showX, showY);
          setBlock(worldId, showX, showY, nBlock);
        }, 100);
        updateItemIcon(showX, showY, [noteText.value()]);
      });
    };

    let noteDiv = createElement('div');
    noteDiv.parent(infBox);

    let noteText = createElement('input');
    noteText.parent(noteDiv);
    noteText.elt.style.width = '175px';
    noteText.elt.style.fontSize = '80%';
    noteText.elt.onkeydown = (keyEv) => {
      if (keyEv.key === 'Enter') {
        submitNote();
      }
    };

    let noteBut = createElement('input');
    noteBut.parent(noteDiv);
    noteBut.elt.type = 'submit';
    noteBut.elt.style.width = '120px';
    noteBut.value('⏎ Make a note');

    noteBut.elt.onclick = submitNote;
  }
};

const curLocParams = (x, y) => {
  const xAdj = Math.ceil(x / dims.res) - 1;
  const yAdj = Math.ceil(y / dims.res) - 1;
  const showX = Math.ceil(xAdj - dims.xoff);
  const showY = Math.ceil(yAdj - dims.yoff);
  const oNoise = showNoise(showX, showY);
  if ('debug' in qs) { console.log(`curLocParams(${x}, ${y}) -> ${showX},${showY} -> ${oNoise}`); }

  return { xAdj, yAdj, showX, showY, oNoise };
};

async function mapSetup() {
  windowResized(null);

  let insLineBreak = Math.floor((Object.keys(ins).length / 2)) - 1;
  let ins_d = createElement('div');
  ins_d.elt.id = 'ins_d';
  if (!('debug' in qs)) {
    ins_d.style('display', 'none');
  }
  Object.keys(ins).forEach((ik, i) => {
    if (i > insLineBreak) {
      createElement('br').parent(ins_d);
      insLineBreak = insLineBreak * 3;
    }
    let _s = createElement('span', `&nbsp;&nbsp;${ik}:`);
    _s.class('ctrllbl');
    _s.parent(ins_d);
    let e = createElement('input');
    e.parent(ins_d);
    e.elt.id = 'ins_' + ik;
    _s.elt.id = 's_' + e.elt.id;
    e.value(ins[ik]());
    e.elt.onchange = (_) => {
      let pv = Number.parseFloat(e.value());
      let igs = ins[ik];
      if (Number.isNaN(pv) || !igs(pv)) {
        e.value(igs());
      } else {
        render();
      }
    };
  });

  createElement('br').parent(ins_d);
 
  canvas = createCanvas(dims.w, dims.h);
  canvas.elt.style.border = '2px solid #aabbcc';

  canvas.mouseClicked(async () => {
    const { showX, showY, oNoise } = curLocParams(mouseX, mouseY);
    
    const oBg = colorXform(oNoise);
    let oFgCA = oBg.map(x => 255 - x);
    const _tc = 92;
    // if bg & fg colors are too close to each other (_tc), push the fg color out by (_tc * 2) or just max it
    oFgCA = oFgCA.map((x, i) => Math.abs(oBg[i] - x) < _tc ? (x + (_tc * 2) > 255 ? 255 : x + (_tc * 2)) : x);
    // pick the highest-valued fg color as greyscale component
    const oFgC = oFgCA.reduce((a, x) => a > x ? a : x, 0);
    const oFg = [oFgC, oFgC, oFgC];

    setSelectedLocation(showX, showY);

    if (worldId) {
      const infBox = select('#infobox');
      infBox.elt.style.color = `rgb(${oFg[0]},${oFg[1]},${oFg[2]})`;
      infBox.elt.style.backgroundColor = `rgb(${oBg[0]},${oBg[1]},${oBg[2]})`;
      infBox.elt.style.border = `1px solid ${infBox.elt.style.color}`;
      infBox.html(`<i>loading <b>(${showX}, ${showY})</b>...</i>`);
      const nBlock = await blockLoader(worldId, showX, showY);
      await setBlock(worldId, showX, showY, nBlock);
    }
  })

  noStroke();
  select('#howbox').elt.style.display = 'block';
  mapReady = true;

  if (connected) {
    addConnectedUx();
  }

  render();
}

async function speciesSelect(speciesKey) {
  let sbox = select('#speciesbox');
  sbox.html('');
  select('#specieshdr').html(`This ${speciesSpec[speciesKey].displayName} shall be known as:`);

  let namebox = createInput();
  namebox.parent(sbox);
  namebox.elt.id = 'namebox';
  namebox.elt.style.width = '60%';
  let firstname = await faunaFetch(`util/faker/firstname`);
  namebox.value(firstname.firstname);
  createElement('br').parent(sbox);

  let setname = createInput('Take Flight!', 'submit');
  setname.parent(sbox);
  setname.elt.id = 'namebox_go';
  setname.elt.style.width = '40%';
  setname.elt.onclick = async () => {
    let avatarRes = await faunaFetch(`avatar`, { 
      species: speciesKey,
      name: select('#namebox').value()
    });
    avatarId = avatarRes.avatarId;
    console.log(`AVATAR: ${avatarId}`);
    document.cookie = `${config.cookieName}=${avatarId}`;
    sbox.html('');
    select('#userbox').elt.style.display = 'none';
    mapSetup();
  };

  createElement('br').parent(sbox);
  sbox.elt.style.padding = '3%';
  sbox.elt.style.display = 'block';

  return true;
}

async function userPrompt() {
  let kvCookies = document.cookie.replace(/\s+/g, '').split(';')
    .map(x => x.split('=')).reduce((a, x) => {
      a[x[0]] = x[1];
      return a;
    }, {});

  if (config.cookieName in qs) {
    avatarId = qs[config.cookieName];
    document.cookie = `${config.cookieName}=${avatarId}`;
    console.log(`AVATAR (qs!): ${avatarId}`);
    if (avatarId === 'null') {
      window.history.pushState('avatar reset', 'Fauna', '/');
    }
  } else if (config.cookieName in kvCookies && 
    kvCookies[config.cookieName] && kvCookies[config.cookieName] !== "null") {
    avatarId = kvCookies[config.cookieName];
    console.log(`AVATAR (cookie!): ${avatarId}`);
  }

  if (avatarId) {
    avatar = await fetchAvatar(avatarId);
  }

  loadingScr.p.removeChild(loadingScr.e.elt);
  if (!avatar) {
    let userbox = select('#userbox');
    userbox.elt.style.display = 'block';
    select('#ub_new').elt.style.display = 'block';

    select('#attrmax').html(gameCfg.meta.statMax);
    select('#tranqmax').html(gameCfg.meta.tranquilityMax);
    select('#attrcarry').html(gameCfg.meta.inventoryMax);

    let sbox = select('#speciesbox');
    let shtml = '<table id="speciestable"><tr>';
    let cellCount = 0;
    Object.keys(speciesSpec).forEach(sKey => {
      const sspec = speciesSpec[sKey];
      shtml += `<td class='speciescell'><a href='#' onclick='speciesSelect("${sKey}");'>` + 
        `<img src='assets/${sKey}.png' class='speciesavatar' /></a><br/>`;
      shtml += `<span class='speciesname'>${sspec.displayName}</span><br/>`;
      shtml += '<div class="speciesstats">';
      shtml += '<table class="speciesstats_table">';
      Object.keys(sspec.stats).sort().forEach(statKey => {
        let sCCls = `statclr_${sspec.stats[statKey]}`;

        if (statKey === 'tranquility') {
          let tq = sspec.stats[statKey];
          sCCls = 'statclr_' + (tq === 1 ? '2' : (tq === 2 ? '7' : '10'));
        }

        shtml += `<tr><td>${statKey}</td><td class='statclr_cell'>` + 
          `<span class='statclr ${sCCls}'>${sspec.stats[statKey]}</span></td></tr>`;
      });
      shtml += '</table></div></td>';
      if (!(++cellCount % 3)) {
        shtml += '</td></tr><tr><td colspan="3"><br/></td></tr><tr>';
      }
    });
    shtml += '</tr></table>';
    sbox.html(shtml);

    let ibox = select('#itembox');
    let ihtml = '<table style="width: 100%">';
    ihtml += '<tr style="font-variant: small-caps;"><td>Name</td><td>Icon</td><td>Chance</td><td>Poss. Values</td><td>Adds</td></tr>';
    Object.values(gameCfg.items).flat().forEach(item => {
      ihtml += `<tr><td>${item.name}</td><td>${getItemSig(item)}</td><td><i>${(item.generate * 1e32) / 1e30}%</i></td><td>+` +
        (item.range[0] === item.range[1] ? item.range[0] : `${item.range[0]}-${item.range[1]}`) +
        `</td><td>${item.affect}</td>`;
    });
    ibox.html(ihtml + '</table>');
  } else {
    await mapSetup();
  }
}

function preload() {
  loadingScr.e = select('#p5_loading');
  loadingScr.p = loadingScr.e.elt.parentNode;

  if (config.preloadImages.length) {
    console.log(`preloading ${config.preloadImages.length} images:`);
    config.preloadImages.forEach(asset => {
      loadImage(`assets/${asset}`, (loadedImg) => {
        preloads[asset] = loadedImg;
        preloads[asset].__fauna_asset_name = asset;
        console.log(`loaded ${asset}`);
        loadingScr.e.html(loadingScr.e.html() + `Pre-loaded ${asset}<br/>`);
      })
    });
  }
}

async function setup() {
  loadingScr.p.appendChild(loadingScr.e.elt);

  loadingScr.e.html(loadingScr.e.html() + '<br/>Contacting server...<br/>');
  let apiVer = await apiCheck();
  loadingScr.e.html(loadingScr.e.html() + 'Server found!<br/>');

  if (apiVer !== null) {
    console.log(`Fauna v${apiVer}`);
    loadingScr.e.html(loadingScr.e.html() + `<br/><h2>Fauna v${apiVer} loaded!</h2>`);
    document.title = `Fauna`;
  } else {
    loadingScr.p.removeChild(loadingScr.e.elt);
    let sad_d = createElement('div');
    sad_d.html('<h1>No server found!</h1>');
  }

  await userPrompt();
}

function draw() {
  noLoop();
}

