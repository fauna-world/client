# Fauna

What started as a simple, COVID-19-lockdown-boredom-induced experiment into [perlin noise](https://en.wikipedia.org/wiki/Perlin_noise) with [p5.js](https://p5js.org/) rapidly & uncontrollably morphed into... whatever _this_ is.

Probably easiest to call it 'a rudimentary 2D browser-based game engine without a game', at this point. There are grand plans for it, of course. Will they materialize? Only time will tell...

Technical notes:
* 'infinite' worlds, each world 'infinitely'-sized and every block has the capability to persist
* slim client with `p5.js` as the sole external code depedency 
* [node](https://nodejs.org/en/) server backed by [redis](https://redis.io) with sparse memory model
* interactive server console with introspection and messaging functionality
* 'realtime' messaging (including chat) via [websockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)

See it at [fauna.computerpho.be](http://fauna.computerpho.be)
