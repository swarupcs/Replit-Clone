import child_process from "node:child_process";
import util from "node:util";

export const execPromisified = util.promisify(child_process.exec);
