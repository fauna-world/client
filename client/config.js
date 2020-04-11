const config = {
  host: 'http://api.fauna.computerpho.be',
  msgHost: 'ws://ws.api.fauna.computerpho.be',
  cookieName: 'faunaAvatar',
  heartbeat: 3,
  uiDefaults: {
    w: 960, 
    h: 768, 
    res: 16, 
    scale: Number.parseFloat(Math.round(((Math.random() * 0.01) + 0.05) * 100) / 100), 
    scaleStep: 0.01,
    seed: Number.parseInt(Math.random() * 42) + 1, 
    lod: Number.parseInt(Math.round((Math.random() * 1) + 3)),
    falloff: Number.parseFloat(Math.round(((Math.random() * 0.01) + 0.69) * 100) / 100), 
    xoff: 0, 
    yoff: 0, 
    ss: 75, 
    scrollStep: 1, 
    chatHist: 10,
    boxSelectBorderColor: [0, 255, 255]
  },
  uiMultipliers: {
    width: 0.55,
    height: 0.7
  },
  preloadImages: [
    'bluebird.png',
    'butterfly.png',
    'crow.png',
    'hummingbird.png',
    'morningdove.png',
    'sparrow.png'
  ]
};
