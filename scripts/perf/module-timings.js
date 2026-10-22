// Metro polyfill for the performance harness (metro.config.js adds it only
// when BULWARK_MODULE_TIMINGS is set at bundle time; release builds don't
// have it). It wraps every module factory and adds up how long each module's
// own code ran when it was first evaluated, without the modules it required
// meanwhile. src/lib/perf-marks.ts logs the slowest ones at first inbox.
(function (g) {
  var define = g.__d;
  if (typeof define !== 'function') return;
  var now = typeof g.nativePerformanceNow === 'function'
    ? g.nativePerformanceNow
    : function () { return Date.now(); };
  var times = {};
  var stack = [];
  g.__bulwarkModuleTimes = times;
  g.__d = function (factory, moduleId, dependencyMap, verboseName) {
    var timed = function () {
      var start = now();
      stack.push(0);
      try {
        return factory.apply(this, arguments);
      } finally {
        var total = now() - start;
        var nested = stack.pop();
        times[moduleId] = (times[moduleId] || 0) + (total - nested);
        if (stack.length > 0) stack[stack.length - 1] += total;
      }
    };
    return define(timed, moduleId, dependencyMap, verboseName);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
