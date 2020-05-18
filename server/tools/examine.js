module.exports = {
  runTool: async (opts) => {
    console.log((await opts.server.getRuntimeInfo()));
  },
  displayName: () => 'Examine'
};
