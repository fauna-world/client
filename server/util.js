const fs = require('fs');
const config = require('config');

const PKGJSON = JSON.parse(fs.readFileSync('package.json'));
const VERSION = PKGJSON.version;
const NAME = PKGJSON.name;

const crypto = require('crypto');

const calcShasum = (checkStr) =>
  crypto.createHash('sha256').update(checkStr).digest('hex');

const validWorldId = (id) => id.length === 64 && id.match(/[a-f0-9]+/) !== null;

const validUuid = (uuid) => {
  // https://stackoverflow.com/a/13653180
  const validUuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/
  return uuid.match(validUuidRegex) !== null
};

const sanitize = (dirty, lenLim = config.app.sanitize.lengthLimit) => {
  if (typeof dirty === 'object') {
    return Object.keys(dirty).reduce((a, k) => {
      a[k] = sanitize(dirty[k]);
      return a;
    }, {});
  } else if (Array.isArray(dirty)) {
    return dirty.map(x => sanitize(x));
  } else if (typeof dirty === 'string') {
    // first, remove any fully-formed HTML opening or closing tags
    return dirty.replace(/<\/?.+?>/g, '')
      // then encode HTML unsafe characters, courtesy of:
      // https://stackoverflow.com/a/6234804
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;")
      // finally, truncate to spec'ed length limit
      .substring(0, lenLim).trim();
  }
  
  return dirty;
};

const manhattanDist = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);

const manhattanDistObj = (loc1, loc2) => manhattanDist(loc1.x, loc1.y, loc2.x, loc2.y);

const scoreCatHeadings = {
  'moved': 'Total distance flown',
  'from-origin': 'Distance flown from start block',
  'gardenspaces': 'Number of gardenspaces captured',
  'gardenspace-blocks': 'Total blocks captured in all owned gardenspaces',
  'nests-built': 'Total nests built'
};

module.exports = {
  calcShasum,
  validWorldId,
  validUuid,
  sanitize,
  manhattanDist,
  manhattanDistObj,
  scoreCatHeadings,
  PKGJSON,
  NAME,
  VERSION
};
