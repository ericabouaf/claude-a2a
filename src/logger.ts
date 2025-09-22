import chalk, { ChalkInstance, ColorName } from 'chalk';

const directionStyles = {
  in: chalk.bgGreen.black,
  out: chalk.bgBlue.white,
  error: chalk.bgRed.white,
  debug: chalk.bgGray.black,
};


function createLogger(channel: string, color: ColorName = 'cyan') {
  const coloredChalkInstance = chalk[color] as ChalkInstance;
  const channelLabel = coloredChalkInstance(`[${channel}]`);

  return (direction: 'in'|'out'|'error'|'debug', ...args: any) => {
    const ts = chalk.dim(new Date().toISOString().slice(11, 19)); // HH:MM:SS
    const dir = directionStyles[direction] || ((x) => x);
    console.log(`${ts} ${channelLabel} ${dir(direction.toUpperCase())}`, ...args);
  };
}

export const a2aLog = createLogger('A2A', 'cyan');
export const claudeLog = createLogger('Claude', 'magenta');
