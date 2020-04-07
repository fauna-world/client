const config = require('config');
const inq = require('inquirer');
const chalk = require('chalk');
const moment = require('moment');
const readline = require('readline');

const server = require('./http');
const tools = require('./tools');
const { INFO_CHAR, OK_CHAR, ALERT_CHAR, WORKING_CHAR } = require('./style');

const logger = {
  error: console.error,
  log: console.log,
  warn: console.log,
  verbose: console.log,
  debug: console.log,
  info: console.log
};

let _mainStart;

const menuBanner = () => console.log(INFO_CHAR + chalk.bold(' [' + chalk.bgBlue('ESC') + 
  `] shows and hides ${chalk.green('the menu')}, ` + `[${chalk.yellow('CTRL+C')}] exits`));

let theFullMenu_promptHandle;
let autohideHandle;
let fullMenuUp = false;

const menuReset = (forced = false) => {
  clearTimeout(autohideHandle);
  if (forced) {
    if (!theFullMenu_promptHandle) {
      throw new Error('forced close without handle');
    }
    theFullMenu_promptHandle.ui.close();
    theFullMenu_promptHandle = undefined;
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  fullMenuUp = false;
  console.log();
  menuBanner();
  server.resumeConsoleLogging();
};

const autohideTimer = (reset = true) => {
  if (config.app.menuAutohideDelay) {
    clearTimeout(autohideHandle);
    if (reset) {
      autohideHandle = setTimeout(() => menuReset(true), (config.app.menuAutohideDelay * 1000));
    }
  }
};

const startAutohideTimer = autohideTimer.bind(null, true);
const resetAutohideTimer = autohideTimer.bind(null, true);
const stopAutohideTimer = autohideTimer.bind(null, false);

const theFullMenu = async () => {
  let loopCount = 0;
  if (fullMenuUp) {
    throw new Error('nope');
  }
  fullMenuUp = true;
  while (true) {
    try {
      let fullMap = Object.keys(tools).filter(x => 'runTool' in tools[x]).reduce((a, x) => {
        let tKey = x;
        if ('displayName' in tools[x]) {
          tKey = tools[x].displayName();
        }

        a[tKey] = tools[x];
        return a;
      }, {});

      startAutohideTimer();
      let choices = Object.keys(fullMap).sort();

      theFullMenu_promptHandle = inq.prompt({
        type: 'list',
        name: 'choice',
        message: `Main menu${(loopCount++ > 1 ? `; [${chalk.bgBlue('ESC')}] hides` : '')}:`,
        choices: choices
      });

      let opt = await Promise.resolve(theFullMenu_promptHandle);
      stopAutohideTimer();

      await fullMap[opt.choice].runTool({ server });
    } catch (ilErr) {
      console.log(`${ALERT_CHAR} unknown error '${chalk.yellow(ilErr.message)}':`);
      console.log(ilErr);
      logger.error(`inner loop exception: ${ilErr.message}\n${ilErr}`);
    }
  }
};

const appCleanup = async () => {
  const ranTime = Date.now() - _mainStart;
  logger.info(`${WORKING_CHAR} closing; ran for ${moment.duration(ranTime).humanize()} (${ranTime})`);
  await server.stop();
  console.log(chalk.bold(`${OK_CHAR} Done!`));
  process.exit(0);
};

const main = async () => {
  _mainStart = Date.now();

  server.start(() => {
    logger.info(`Initialized in ${Date.now() - _mainStart}ms`);
  
    process.on('SIGINT', appCleanup);

    process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin);

    menuBanner();

    process.stdin.on('keypress', (str, key) => {
      resetAutohideTimer();

      if (!fullMenuUp && key.name === 'escape' && key.meta) {
        if (theFullMenu_promptHandle) {
          throw new Error('no theFullMenu_promptHandle here!');
        }

        server.pauseConsoleLogging();
        theFullMenu().then(menuReset);
      }
      else if (fullMenuUp && key.name === 'escape' && key.meta && theFullMenu_promptHandle) {
        if (theFullMenu_promptHandle.ui.activePrompt.status === 'pending') {
          menuReset(true);
        }
      }
      else if (key.name === 'c' && key.ctrl === true) {
        appCleanup();
      }
    });
  });
};

(async () => main())();
