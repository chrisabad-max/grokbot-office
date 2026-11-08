// Entry so that `node --test server/test/` works on Node >= 22 (directories are no longer expanded).
import './state.test.js';
import './journal.test.js';
import './server.test.js';
import './viewkey.test.js';
import './feedbase.test.js';
