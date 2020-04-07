const inq = require('inquirer');
const chalk = require('chalk');

let chatLogging;

module.exports = {
  runTool: async (opts) => {
    let cSocks = opts.server.getConnectedSockets();

    let main = { choice: null };
    while (!main.choice || !main.choice.match(/^Back/)) {
      main = await inq.prompt({
        type: 'list',
        message: 'Select operation:',
        name: 'choice',
        choices: ['Send message', 'List dead messages', 
          (chatLogging === undefined ? 'Toggle' : 
            (chatLogging ? 'Disable' : 'Enable')) + 
              ' chat console logging', 
          'Back to Main Menu']
      });

      if (main.choice.match(/^Send/)) {
        if (Object.keys(cSocks).length === 0) {
          console.log('No connected clients!');
          return;
        }

        let toList = Object.keys(cSocks);
        toList.unshift('global');

        let to = await inq.prompt({
          type: 'list',
          message: 'To:',
          name: 'choice',
          choices: toList
        });

        let msg = await inq.prompt({
          type: 'input',
          message: 'Message to send?',
          name: 'choice'
        });

        let msgStr = JSON.stringify({
          payload: msg.choice,
          type: 'chat',
          from: { name: 'ServerConsole' },
          to: to.choice,
          localTs: Date.now()
        });

        if (to.choice === 'global') {
          Object.values(cSocks).forEach(c => c.send(msgStr));
        } else {
          cSocks[to.choice].send(msgStr);
        }
      }
      else if (main.choice.match(/^List/)) {
        if (Object.keys(cSocks).length === 0) {
          console.log('No connected clients!');
          return;
        }

        let client = await inq.prompt({
          type: 'list',
          message: 'Select client:',
          name: 'choice',
          choices: Object.keys(cSocks)
        });

        console.log(cSocks[client.choice].rxQueue);
      } else if (main.choice.match(/chat\s+console\s+logging/)) {
        chatLogging = opts.server.toggleChatConsoleLogging();
        console.log(`Chat logging-to-console is now ` + 
          `${chalk.bold((chatLogging ? 'en' : 'dis') + 'abled')}`);
      }
    }
  },
  displayName: () => 'Messaging'
};
