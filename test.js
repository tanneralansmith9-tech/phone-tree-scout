require('dotenv').config();
try { require('./src/callStore'); console.log('callStore OK'); } catch(e) { console.log('callStore FAIL:', e.message); }
try { require('./src/services/hubspot'); console.log('hubspot OK'); } catch(e) { console.log('hubspot FAIL:', e.message); }
try { require('./src/services/ai'); console.log('ai OK'); } catch(e) { console.log('ai FAIL:', e.message); }
try { require('./src/routes/twilio'); console.log('twilio OK'); } catch(e) { console.log('twilio FAIL:', e.message); }
