const isLocal = location.hostname === 'localhost';

const config = {
  host: isLocal ? 'http://localhost:14024' : 'http://api.fauna.computerpho.be',
  msgHost: isLocal ? 'ws://localhost:14025' : 'ws://ws.api.fauna.computerpho.be',
  cookieName: 'faunaAvatar',
  heartbeat: 41,
  uiDefaults: {
    w: 960, 
    h: 768, 
    res: 20, 
    scaleStep: 0.01,
    seed: 42042,
    scale: 0.075,
    lod: 5,
    falloff: 0.442,
    xoff: 0, 
    yoff: 0, 
    ss: 75, 
    scrollStep: 1, 
    chatHist: 10,
    boxSelectBorderColor: [255, 255, 0]
  },
  uiMultipliers: {
    width: 0.45,
    height: 0.85
  },
  preloadImages: [
    'bluebird.png',
    'butterfly.png',
    'crow.png',
    'hummingbird.png',
    'morningdove.png',
    'sparrow.png',
    'tombstone.png',
    'item.png',
    'note.png'
  ]
};
