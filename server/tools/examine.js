module.exports = {
  runTool: async (opts) => {
    console.log(opts.server.getRuntimeInfo());
  },
  displayName: () => 'Examine'
};
