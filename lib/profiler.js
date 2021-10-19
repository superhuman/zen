import Zen from './index';
export function logBatch(metrics) {
    let log = Zen.config.log;
    if (!log)
        return;
    return log(metrics);
}
export function log(name, fields) {
    return logBatch([{ name, fields }]);
}
