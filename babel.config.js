module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-reanimated 4.x moved its worklet transform into the
    // separate react-native-worklets package. This must be listed last.
    plugins: ['react-native-worklets/plugin'],
  };
};
