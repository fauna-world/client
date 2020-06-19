const isLocal = location.hostname === 'localhost' || 
	location.hostname.startsWith('192.168.') ||
	location.hostname.startsWith('10.0.');

const config = {
  host: isLocal ? `http://${location.hostname}:14024` : 'http://api.fauna.computerpho.be',
  msgHost: isLocal ? `ws://${location.hostname}:14025` : 'ws://ws.api.fauna.computerpho.be',
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
    chatHist: 1,
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
    'note.png',
    'nest.png',
    'clock.png',
    'twig.png',
    'stick.png',
    'worm.png',
    'grub.png',
    'seeds.png',
    'bvm.png',
    'gardenspace_0.png',
    'gardenspace_1.png',
    'gardenspace_2.png',
    'gardenspace_3.png',
    'gardenspace_4.png',
    'gardenspace_5.png',
    'gardenspace_6.png',
    'gardenspace_7.png',
    'gardenspace_8.png',
    'gardenspace_9.png',
    'gardenspace_10.png',
    'gardenspace_11.png'
  ],
  gs: {
    numImgs: 12,
    shufPasses: 5
  },
  filters: {
    items: ['nest', 'item', 'tombstone', 'note'],
    permanents: ['gardenspace']
  }
};
