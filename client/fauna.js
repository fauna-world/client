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
  
  if (res.status !== 200) {
    throw new Error('faunaFetch');
  }

  let ret = await res.json();

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

if ('worldId' in qs) {
  worldId = qs.worldId;
}

const ourNoise = (x, y) => noise(
  (x - dims.xoff) * dims.scale, 
  (y - dims.yoff) * dims.scale
);

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

const render = () => {
  if (!mapReady) {
    return;
  }

  clear();
  noiseDetail(dims.lod, dims.falloff);
  noiseSeed(dims.seed);

  let rd = { w: dims.w / dims.res, h: dims.h / dims.res };
  curMap = [];
  for (let x = 0; x < rd.w; x++) {
    if (curMap[x] === undefined) {
      curMap[x] = [];
    }

    for (let y = 0; y < rd.h; y++) {
      curMap[x][y] = ourNoise(x, y);
      let mapCoords = [x - dims.xoff, y - dims.yoff];
      let mapCoordStr = `${mapCoords[0]},${mapCoords[1]}`;
      let fillObj = colorXform(curMap[x][y]);

      if (mapCoordStr in mapLocs) {
        let luFill = mapLocs[mapCoordStr];
        fillObj = typeof luFill === 'function' ? luFill(mapCoords, fillObj) : luFill;
        if (typeof fillObj === 'function') {
          fillObj = fillObj(mapCoords, fillObj);
        }
      }

      let properDims = [x * dims.res, y * dims.res, dims.res, dims.res];

      if (Array.isArray(fillObj)) {
        fill(...fillObj);
        rect(...properDims);
      } else if (typeof fillObj === 'object') {
        fill(255, 255, 255, 255);
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

let _lastSelLoc;
let _origCellFill;

const updateAvatarInfo = (x, y) => {    
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
      mapLocs[curLocStr] = (_, origFill) => _borderCell(origFill, config.uiDefaults.visitedBorderColor);
    }

    if (!uiOnly) {
      avatar = setBlock.avatar;
    }

    avatarLoc.cur = { x, y };
    mapLocs[newLoc] = preloads[`${avatar.species}.png`];

    updateAvatarInfo(x, y);
    render();

    if (avatar.life === 0) {
      alert(`You have perished after flying a distance of ${avatar.scores.moved} blocks, ` +
        `${avatar.scores.fromOrigin} blocks from where you began.` + '\n\nPlease click "RESET!" to begin anew.');
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

const ins = {
  xoff: gs.bind(null, 'xoff', allow_any, null),
  yoff: gs.bind(null, 'yoff', allow_any, null),
  res: gs.bind(null, 'res', (v) => v >= 6 && (v % 2) === 0, null),
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

  avbox.html(`<a href='${persistUrl(true)}'>` +
    `<img src='assets/${imgFileName}' class='speciesavatar' /></a>` +
    `<div class='speciesname'>${avatar.name}</div>` + 
    '<div id="avatarstatsdiv" class="dispnone"></div>');

  avbox.elt.style.display = 'block';

  if (avatar.loc) {
    await setAvatarLoc(avatar.loc.x, avatar.loc.y, true);
  }
}

let lm_backoff = 0;
let lm_handle;
async function loadMessaging(reconnect = false) {
  console.log(`loadMessaging(${reconnect}), bo=${lm_backoff}`);
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
          `${String(gameDate.getFullYear()).padStart(4, '0')}</span>`
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

    if (avatar.loc) {
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
  };

  await loadAvatar();
  loadMessaging();

  if (!avatar.loc && !('enterImmediate' in qs || 'worldId' in qs)) {
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

  const infBox = select('#infobox');
  canvas.mouseClicked(async () => {
    const xAdj = Math.ceil(mouseX / dims.res) - 1;
    const yAdj = Math.ceil(mouseY / dims.res) - 1;
    const showX = Math.ceil(xAdj - dims.xoff);
    const showY = Math.ceil(yAdj - dims.yoff);
    const oNoise = ourNoise(xAdj, yAdj);
    
    const oBg = colorXform(oNoise);
    let oFgCA = oBg.map(x => 255 - x);
    const _tc = 92;
    // if bg & fg colors are too close to each other (_tc), push the fg color out by (_tc * 2) or just max it
    oFgCA = oFgCA.map((x, i) => Math.abs(oBg[i] - x) < _tc ? (x + (_tc * 2) > 255 ? 255 : x + (_tc * 2)) : x);
    // pick the highest-valued fg color as greyscale component
    const oFgC = oFgCA.reduce((a, x) => a > x ? a : x, 0);
    const oFg = [oFgC, oFgC, oFgC];

    setSelectedLocation(showX, showY);

    const loadBlock = async (worldId, showX, showY, preloadedBlock) => {
      let res;
      let rootQStr = `world/${worldId}/block/${showX}/${showY}`;

      if (!preloadedBlock) {
        let qStr = `${rootQStr}?n=${oNoise}`;
        res = await faunaFetch(qStr);
      } else {
        res = { block: preloadedBlock };
      }

      infBox.html(`<b>(${showX}, ${showY})</b> is <b>${res.block.type}</b> ` + 
        (res.block.count > 0 ? `<br/>with <b>${res.block.count}</b> visitor${res.block.count == 1 ? '' : 's'}` : '') + '<br/><br/>');

      let isCurrentAvatarLoc = false;

      if (avatarLoc) {
        let startBut = createElement('input');
        startBut.elt.id = 'beginbut';
        startBut.elt.type = 'submit';
        startBut.elt.onclick = async () => {
          startBut.elt.parentNode.removeChild(startBut.elt);
          let newBlockInfo = await setAvatarLoc(showX, showY);
          loadBlock(worldId, showX, showY, newBlockInfo);
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

      const itemsToRender = res.block.inventory.filter(x => x.type === 'item' && x.payload.type === 'consumable');

      // TODO: render as a table, too?
      if (itemsToRender.length) {
        const itemsDiv = createElement('div');
        itemsDiv.parent(infBox);
        itemsDiv.html('<u>Available items</u>:<br/>');
        itemsDiv.elt.id = 'itemsdiv';
        itemsToRender.forEach(itemCont => {
          let item = itemCont.payload;
          const itemDiv = createElement('div');
          itemDiv.parent(itemsDiv);

          let eatBut = createInput('Eat', 'submit');
          eatBut.parent(itemDiv);
          eatBut.class('eatbut');
          eatBut.elt.id = `eat_item_${item.id.substring(0, 8)}`;

          eatBut.elt.onclick = async () => {
            let res = await faunaFetch(`avatar/${avatarId}/loc`, { worldId: worldId, x: showX, y: showY, itemId: item.id });
            if (res.success) {
              avatar = res.avatar;
              updateAvatarInfo(showX, showY);
              loadBlock(worldId, showX, showY, res.block);
            }
          };

          if (avatar.life <= 0 || 
            avatar.consumeAllowed <= 0 ||
            !(avatar.loc && avatar.loc.x === showX && avatar.loc.y === showY)) {
            eatBut.elt.disabled = true;
          }

          let itemSpan = createElement('span');
          itemSpan.parent(itemDiv);
          itemSpan.html(`&nbsp;"${item.name}", <b>+${item.stat}</b> ${item.affect}`);
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

      // only allow note submission if the player is at the block
      if (isCurrentAvatarLoc) {
        const submitNote = () => {
          faunaFetch(`${rootQStr}/add`, {
            type: 'note',
            payload: noteText.value(),
            poster: Object.assign({}, avatar, { id: avatarId })
          }).then(() => setTimeout(() => loadBlock(worldId, showX, showY), 100));
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

    if (worldId) {
      infBox.elt.style.color = `rgb(${oFg[0]},${oFg[1]},${oFg[2]})`;
      infBox.elt.style.backgroundColor = `rgb(${oBg[0]},${oBg[1]},${oBg[2]})`;
      infBox.elt.style.border = `1px solid ${infBox.elt.style.color}`;
      infBox.html(`<i>loading <b>(${showX}, ${showY})</b>...</i>`);
      await loadBlock(worldId, showX, showY);
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
  select('#attrexplainerbox').style('display', 'none');
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

