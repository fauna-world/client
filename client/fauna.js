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
let speciesSpec;
let gameMeta;

if (location.search) {
  qs = location.search.replace('?', '').split('&').map(x => x.split('=')).reduce((a, x) => { 
    a[x[0]] = x[1];
    return a;
  }, {});
}

// w/o body is GET, with is POST
const faunaFetch = async (stub, body) => {
  let opts = { 
    headers: {
      'Content-type': 'application/json'
    }
  };

  if (body) {
    opts.method = 'POST';
    opts.body = JSON.stringify(body);
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
    let res = await fetch(config.host);
    let text = await res.text();
    if (text.match(/^[\d\.]+$/) !== null) {
      let sRes = await faunaFetch('species');
      let mRes = await faunaFetch('meta');
      speciesSpec = sRes.species;
      gameMeta = mRes;
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

const ourNoise = (x, y) => noise(
  (x - dims.xoff) * dims.scale, 
  (y - dims.yoff) * dims.scale
);

const colorXform = (noiseVal) => {
  const _x2 = '_x2' in qs ? Number.parseInt(qs['_x2']) : 0;
  const breaks = {
    0.2: (brk, nv, invNv) => [0+_x2, (64+_x2) * invNv, (192+_x2) * invNv],
    0.4: (brk, nv, invNv) => [128 - (64 * invNv), 212 * invNv, 92 * nv],
    0.6: (brk, nv, invNv) => [255 - (128 * invNv), 255 - (92 * invNv), 255 - (192 * invNv)],//[212 * invNv, 192 * invNv, 128 * invNv]//[212 * nv, 192 * nv, 128 * nv]
    0.8: (brk, nv, invNv) => [255 * nv, 255 * nv, 255 * nv * (1.1 * invNv)]
  };

  let bk = Object.keys(breaks).sort().find(bk => noiseVal < Number.parseFloat(bk));
  let bkFl = Number.parseFloat(bk);
  return bk ? breaks[bk](bkFl, noiseVal, ((1 / bkFl) * noiseVal)) : Array(3).fill(noiseVal * 255); 
};

const render = () => {
  if (!mapReady) {
    return;
  }

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
      fill(...colorXform(curMap[x][y]));
      rect(x * dims.res, y * dims.res, dims.res, dims.res);
    }
  }
};

const updateChatBox = () => select('#chatmain').html(
  chatLog.slice(-dims.chatHist).map(x => `&lt;<b>` + 
    (x.from.species ? `<img src='assets/${x.from.species}.png' class='chatimg'/>` : '') + 
    `${x.from.name}</b>&gt; ${x.payload}`).join('<br/>')
);

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
  res: gs.bind(null, 'res', (v) => v >= 4 && (v % 2) === 0, null),
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
const persistQs = () => insLock.map((ik) => `${ik}=${dims[ik]}`).join('&') + '&enterImmediate';
const persistUrl = (avatar = false) => `http://${location.hostname}/?` + (avatar ? persistAv() : persistQs());

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

  avbox.html(`<a href='${persistUrl(true)}'>` +
    `<img src='assets/${avatar.species}.png' class='speciesavatar' /></a>` +
    `<div class='speciesname'>${avatar.name}</div>`);

  avbox.elt.style.display = 'block';
}

async function loadMessaging() {
  let wsConn = new WebSocket(`${config.msgHost}/?${config.cookieName}=${avatarId}`);
  let chatbox = select('#chatbox');

  wsConn.addEventListener('open', () => {
    chatbox.style('display', 'block');

    let sendBut = select('#chatsend');
    let sendTxt = select('#chattext');
    sendBut.elt.onclick = () => {
      let chkVal = sendTxt.value().trim();
      if (chkVal.length)
      wsConn.send(JSON.stringify({
        type: 'chat',
        payload: chkVal,
        from: Object.assign({}, avatar, { id: avatarId }),
        localTs: Date.now(),
        to: 'global'
      }));
      sendTxt.value('');
    };
  });

  const _seasons = ['Winter', 'Winter', 'Spring', 'Spring', 'Spring', 
  'Summer', 'Summer', 'Summer', 'Fall', 'Fall', 'Fall', 'Winter'];
  const _months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  wsConn.addEventListener('message', () => {
    try {
      let msgObj = JSON.parse(event.data);

      if (msgObj.type === 'chat') {
        chatLog.push(msgObj);
        updateChatBox();
      } else if (msgObj.type === 'gametime') {
        select('#gameclock').style('display', 'block');
        let gameDate = new Date(msgObj.payload.time);
        select('#gameclock').html(_seasons[gameDate.getMonth()] + ' ' + 
          `${String(gameDate.getFullYear()).padStart(4, '0')}<!--${msgObj.payload.epoch}-->`);
      }
    } catch (err) {
      console.log(`bad msg rx'ed! ${event.data}:`);
      console.log(err);
    }
  });

  wsConn.addEventListener('close', (ev) => {
    console.log('Messaging channel closed!');
    console.log(ev);
    chatbox.style('display', 'none');
    select('#gameclock').style('display', 'none');
  })

  window.onclose = () => {
    wsConn.close();
  }
}

const addConnectedUx = async () => {
  let worldBanner_d = createElement('div');
  let worldBanner = createElement('h2');
  worldBanner.parent(worldBanner_d);
  worldBanner.elt.style.display = 'none';

  const goBut_d = createElement('div');
  const goButClicked = async () => {
    mapLocked = true;
    goBut_d.elt.style.display = 'none';
    select('body').elt.className = 'go';
    const wSpec = {};
    insLock.forEach(inLock => {
      let e = select('#ins_' + inLock);
      e.elt.disabled = true;
      ins[inLock] = null;
      wSpec[inLock] = e.value();
    });

    select('#chatform').style('display', 'block');
    let jres = await faunaFetch(`world/enter`, wSpec);

    worldId = jres.worldId;
    worldBanner.html(`Welcome to<br/><span style='font-variant: small-caps'>` + 
      `<a href='${persistUrl()}'>${jres.world.name}</a></span>` + 
      `<br/><span style='font-size: 65%;'>(<a href='http://${location.hostname}/'>reset</a>)</span>`);
    worldBanner.elt.style.display = 'block';
    select('#howbox').elt.style.display = 'none';
    if (jres.isNew) {
      worldBanner.elt.style.fontStyle = 'oblique';
    }
  };

  await loadAvatar();
  loadMessaging();

  if (!('enterImmediate' in qs)) {
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

  createElement('br').ins_d;
 
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
    const oFg = oBg.map(x => 128 - x);
    console.log(`r:${dims.res} s:${dims.scale} o:(${dims.xoff}, ${dims.yoff}) -- ` +
      `(${mouseX}, ${mouseY}) (${xAdj}, ${yAdj}) (${showX}, ${showY}) -> ` + 
      `${oNoise} ${noise(showX * dims.scale, showY * dims.scale)}`);
    infBox.elt.style.color = `rgb(${oFg[0]},${oFg[1]},${oFg[2]})`;
    infBox.elt.style.backgroundColor = `rgb(${oBg[0]},${oBg[1]},${oBg[2]})`;
    infBox.elt.style.border = `1px solid ${infBox.elt.style.color}`;

    const loadBlock = async (worldId, showX, showY) => {
      let rootQStr = `world/${worldId}/block/${showX}/${showY}`;
      let qStr = `${rootQStr}?n=${oNoise}`;
      let res = await faunaFetch(qStr);
      infBox.html(`<b>(${showX}, ${showY})</b> is <b>${res.block.type}</b> ` + 
        `<br/>with <b>${res.block.count}</b> visitors` + 
        (res.block.inventory.length ? ` &amp; <b>${res.block.inventory.length}</b> items!` : '') + '<br/><br/>');

      let notesCount = res.block.inventory.reduce((a, x) => a += x.type === 'note' ? 1 : 0, 0);
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

      res.block.inventory.forEach(invItem => {
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

      let noteDiv = createElement('div');
      noteDiv.parent(infBox);

      let noteText = createElement('input');
      noteText.parent(noteDiv);
      noteText.elt.style.width = '175px';
      noteText.elt.style.fontSize = '80%';

      createElement('br').parent(noteDiv);
      let noteBut = createElement('input');
      noteBut.parent(noteDiv);
      noteBut.elt.type = 'submit';
      noteBut.elt.style.width = '150px';
      noteBut.value('Leave a note');

      noteBut.elt.onclick = () => {
        faunaFetch(`${rootQStr}/add`, {
          type: 'note',
          payload: noteText.value(),
          poster: Object.assign({}, avatar, { id: avatarId })
        }).then(() => setTimeout(() => loadBlock(worldId, showX, showY), 100));
      };
    };

    if (worldId) {
      await loadBlock(worldId, showX, showY);
    }
    else {
      infBox.html(`<b>(${showX}, ${showY})</b><br/>${oNoise}<br/><i>${curMap[xAdj][yAdj]}</i>` +
        `<br/>[${oBg.map(x => Math.round(x * 100) / 100).join(', ')}]`);
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

  let setname = createInput('Go', 'submit');
  setname.parent(sbox);
  setname.elt.style.width = '30%';
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
  sbox.elt.style.padding = '5%';
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
  } else if (config.cookieName in kvCookies && 
    kvCookies[config.cookieName] && kvCookies[config.cookieName] !== "null") {
    avatarId = kvCookies[config.cookieName];
    console.log(`AVATAR (cookie!): ${avatarId}`);
  }

  if (avatarId) {
    avatar = await fetchAvatar(avatarId);
  }

  if (!avatar) {
    let userbox = select('#userbox');
    userbox.elt.style.display = 'block';
    select('#ub_new').elt.style.display = 'block';

    let sbox = select('#speciesbox');
    let shtml = '<table id="speciestable"><tr>';
    Object.keys(speciesSpec).forEach(sKey => {
      const sspec = speciesSpec[sKey];
      shtml += `<td><a href='#' onclick='speciesSelect("${sKey}");'>` + 
        `<img src='assets/${sKey}.png' class='speciesavatar' /></a><br/>`;
      shtml += `<span class='speciesname'>${sspec.displayName}</span><br/>`;
      shtml += '<div class="speciesstats">'
      Object.keys(sspec.stats).forEach(statKey => {
        let sCCls = `statclr_${sspec.stats[statKey]}`;
        shtml += `<i>${statKey}</i>: <span class='statclr ${sCCls}'>` + 
          `${sspec.stats[statKey]}</span><br/>`;
      });
      shtml += '</div></td>';
    });
    shtml += '</tr></table>';
    sbox.html(shtml);
  } else {
    await mapSetup();
  }
}

async function setup() {
  let apiVer = await apiCheck();

  if (apiVer !== null) {
    console.log(`Fauna v${apiVer}`);
    document.title = `Fauna`;
  } else {
    let sad_d = createElement('div');
    sad_d.html('<h1>No server found!</h1>');
  }

  await userPrompt();
}

function draw() {
  noLoop();
}

