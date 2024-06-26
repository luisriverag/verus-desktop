/*
MIT License

Copyright (c) 2017 Yuki Akiyama
Copyright (c) 2017 - 2019 SuperNET

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const tls = require('tls');
const net = require('net');
const EventEmitter = require('events').EventEmitter;

const makeRequest = (method, params, id) => {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
    id,
  });
}

const createRecursiveParser = (maxDepth, delimiter) => {
  const MAX_DEPTH = maxDepth;
  const DELIMITER = delimiter;
  const recursiveParser = (n, buffer, callback) => {
    if (buffer.length === 0) {
      return {
        code: 0,
        buffer: buffer,
      };
    }

    if (n > MAX_DEPTH) {
      return {
        code: 1,
        buffer: buffer,
      };
    }

    const xs = buffer.split(DELIMITER);

    if (xs.length === 1) {
      return {
        code: 0,
        buffer: buffer,
      };
    }

    callback(xs.shift(), n);

    return recursiveParser(n + 1, xs.join(DELIMITER), callback);
  }

  return recursiveParser;
}

const createPromiseResult = (resolve, reject, method) => {
  return (err, result) => {
    if (err) {
      console.log(`electrum error for ${method}:`);
      console.log(err);
      //resolve(err);
      reject(err);
    } else {
      resolve(result);
    }
  }
}

class MessageParser {
  constructor(callback) {
    this.buffer = '';
    this.callback = callback;
    this.recursiveParser = createRecursiveParser(20, '\n');
  }

  run(chunk) {
    this.buffer += chunk;

    while (true) {
      const res = this.recursiveParser(0, this.buffer, this.callback);

      this.buffer = res.buffer;

      if (res.code === 0) {
        break;
      }
    }
  }
}

const util = {
  makeRequest,
  createRecursiveParser,
  createPromiseResult,
  MessageParser,
};

const getSocket = (protocol, options) => {
  switch (protocol) {
  case 'tcp':
    return new net.Socket();
  case 'tls':
    // todo
  case 'ssl':
    return new tls.TLSSocket(options);
  }

  throw new Error('unknown protocol');
}

const initSocket = (self, protocol, socketTimeout, options) => {
  const conn = getSocket(protocol, options);

  conn.setTimeout(socketTimeout);
  conn.on('timeout', () => {
    console.log('socket timeout');
    self.onError(new Error('socket timeout'));
    self.onClose();
  });
  conn.setEncoding('utf8');
  conn.setKeepAlive(true, 0);
  conn.setNoDelay(true);
  conn.on('connect', () => {
    self.onConnect();
  });
  conn.on('close', (e) => {
    self.onClose(e);
  });
  conn.on('data', (chunk) => {
    self.onReceive(chunk);
  });
  conn.on('end', (e) => {
    self.onEnd(e);
  });
  conn.on('error', (e) => {
    self.onError(e);
  });

  return conn;
}

class Client {
  constructor(port, host, protocol = 'tcp', socketTimeout = 10000, options = void 0) {
    this.id = 0;
    this.port = port;
    this.host = host;
    this.protocolVersion = null;
    this.callbackMessageQueue = {};
    this.subscribe = new EventEmitter();
    this.conn = initSocket(this, protocol, socketTimeout, options);
    this.mp = new util.MessageParser((body, n) => {
      this.onMessage(body, n);
    });
    this.status = 0;
  }

  setProtocolVersion(version) {
    this.protocolVersion = version;
  }

  connect() {
    if (this.status) {
      return Promise.resolve();
    }

    this.status = 1;

    return new Promise((resolve, reject) => {
      const errorHandler = (e) => reject(e)

      this.conn.connect(this.port, this.host, () => {
        this.conn.removeListener('error', errorHandler);
        resolve();
      });
      this.conn.on('error', errorHandler);
    });
  }

  close() {
    if (!this.status) {
      return
    }

    this.conn.end();
    this.conn.destroy();
    this.status = 0;
  }

  request(method, params) {
    if (!this.status) {
      return Promise.reject(new Error('Connection error'));
    }

    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const content = util.makeRequest(method, params, id);

      this.callbackMessageQueue[id] = util.createPromiseResult(resolve, reject, method);
      this.conn.write(`${content}\n`);
    });
  }

  response(msg) {
    const callback = this.callbackMessageQueue[msg.id];

    if (callback) {
      delete this.callbackMessageQueue[msg.id];

      if (msg.error) {
        callback(msg.error);
      } else {
        callback(null, msg.result);
      }
    } else {
      // can't get callback
    }
  }

  onMessage(body, n) {
    const msg = JSON.parse(body);

    if (msg instanceof Array) {
      // don't support batch request
    } else {
      if (msg.id !== void 0) {
        this.response(msg);
      } else {
        this.subscribe.emit(msg.method, msg.params);
      }
    }
  }

  onConnect() {
  }

  onClose() {
    Object.keys(this.callbackMessageQueue).forEach((key) => {
      this.callbackMessageQueue[key](new Error('close connect'));
      delete this.callbackMessageQueue[key];
    });
  }

  onReceive(chunk) {
    this.mp.run(chunk);
  }

  onEnd() {
  }

  onError(e) {    
    if (e.code && e.code === 'ECONNREFUSED') {
      this.close()
    }
  }
}

class ElectrumJSCore extends Client {
  constructor(port, host, protocol, timeout, options) {
    super(port, host, protocol, timeout, options);
  }

  onClose() {
    super.onClose();
    const list = [
      'server.peers.subscribe',
      'blockchain.numblocks.subscribe',
      'blockchain.headers.subscribe',
      'blockchain.address.subscribe'
    ];

    list.forEach(event => this.subscribe.removeAllListeners(event));
  }

  // ref: http://docs.electrum.org/en/latest/protocol.html
  serverVersion(client_name, protocol_version) {
    let params = [];
    if (client_name) params.push(client_name);
    else params.push('');

    if (protocol_version) params.push(protocol_version.toString());

    return this.request('server.version', params);
  }

  serverBanner() {
    return this.request('server.banner', []);
  }

  serverDonationAddress() {
    return this.request('server.donation_address', []);
  }

  serverPeersSubscribe() {
    return this.request('server.peers.subscribe', []);
  }

  blockchainAddressGetBalance(str) {
    return this.request(this.protocolVersion && this.protocolVersion === '1.4' ? 'blockchain.scripthash.get_balance' : 'blockchain.address.get_balance', [str]);
  }

  blockchainAddressGetHistory(str) {
    return this.request(this.protocolVersion && this.protocolVersion === '1.4' ? 'blockchain.scripthash.get_history' : 'blockchain.address.get_history', [str]);
  }

  blockchainAddressGetMempool(address) {
    return this.request('blockchain.address.get_mempool', [address]);
  }

  blockchainAddressListunspent(str) {
    return this.request(this.protocolVersion && this.protocolVersion === '1.4' ? 'blockchain.scripthash.listunspent' : 'blockchain.address.listunspent', [str]);
  }

  blockchainBlockGetHeader(height) {
    return this.request(this.protocolVersion && this.protocolVersion === '1.4' ? 'blockchain.block.header' : 'blockchain.block.get_header', [height]);
  }

  blockchainBlockGetChunk(index) {
    return this.request('blockchain.block.get_chunk', [index]);
  }

  blockchainEstimatefee(number) {
    return this.request('blockchain.estimatefee', [number]);
  }

  blockchainHeadersSubscribe() {
    return this.request('blockchain.headers.subscribe', []);
  }

  blockchainRelayfee() {
    return this.request('blockchain.relayfee', []);
  }

  blockchainTransactionBroadcast(rawtx) {
    return this.request('blockchain.transaction.broadcast', [rawtx]);
  }

  blockchainTransactionGet(tx_hash, verbose) {
    return this.request('blockchain.transaction.get', verbose ? [tx_hash, true] : [tx_hash]);
  }

  blockchainTransactionGetMerkle(tx_hash, height) {
    return this.request('blockchain.transaction.get_merkle', [tx_hash, height]);
  }
}

module.exports = ElectrumJSCore;