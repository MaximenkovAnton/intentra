export const deriveChannel = (version) =>
  version.split('+')[0].includes('-') ? 'beta' : 'stable';
