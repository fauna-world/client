# Fauna

What started as a simple, COVID-19-lockdown-boredom-induced experiment into [perlin noise](https://en.wikipedia.org/wiki/Perlin_noise)
with [p5.js](https://p5js.org/) rapidly & uncontrollably morphed into... whatever _this_ is:

![0.1.1 banner](http://static.fauna.computerpho.be/0.1.1_banner.png)

Play it at [fauna.computerpho.be](http://fauna.computerpho.be)

Technical notes:
* 'infinite' worlds, each world 'infinitely'-sized, every block in every world with the capability to persist
* slim ['vanilla js'](http://vanilla-js.com/) client with `p5.js` as the sole external code depedency 
* [node](https://nodejs.org/en/) [server](./server) backed by [redis](https://redis.io) with a sparse memory model
* interactive server console with introspection and messaging functionality
* 'realtime' bi-directional message passing (including chat) via [websockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)

