const Promise = require('bluebird');
const {
  RPC_INVALID_ADDRESS_OR_KEY
} = require("../utils/rpc/rpcStatusCodes");
const RpcError = require("../utils/rpc/rpcError");

module.exports = (api) => {      
  // Gets an address balance (z_getbalance), txCount and zTotalBalance are used 
  // to check if the cache needs to be cleared and re-built
  api.native.get_addr_balance = async (coin, address, useCache, txCount = -1, zTotalBalance = -1) => {
    const cacheAddrBalanceResult = (result) => {
      let data = api.native.cache.addr_balance_cache[coin].get("data")
      data[address] = result

      api.native.cache.addr_balance_cache[coin].set("data", data)
    }

    if (useCache) {
      if (
        api.native.cache.addr_balance_cache[coin] != null
      ) {  
        if (txCount !== api.native.cache.addr_balance_cache[coin].get("tx_count")) {
          api.native.cache.addr_balance_cache[coin].set("tx_count", txCount)
          api.native.cache.addr_balance_cache[coin].del("data");
        }

        if (zTotalBalance !== api.native.cache.addr_balance_cache[coin].get('total_balance')) {
          api.native.cache.addr_balance_cache[coin].set("total_balance", zTotalBalance)
          if (api.native.cache.addr_balance_cache[coin].get("data") != null) {
            api.native.cache.addr_balance_cache[coin].del("data");
          }
        }
      }
        
      if (api.native.cache.addr_balance_cache[coin] == null) {
        api.native.cache.addr_balance_cache[coin] = api.create_sub_cache(`native.cache.addr_balance_cache.${coin}`)
        api.native.cache.addr_balance_cache[coin].set("tx_count", -1)
        api.native.cache.addr_balance_cache[coin].set("total_balance", -1)
        api.native.cache.addr_balance_cache[coin].set("data", {})
      } else if (api.native.cache.addr_balance_cache[coin].get('data') == null) {
        api.native.cache.addr_balance_cache[coin].set("data", {})
      }
  
      if (api.native.cache.addr_balance_cache[coin].get('data')[address] != null) {  
        return new Promise((resolve, reject) => {
          if (api.native.cache.addr_balance_cache[coin].get('data')[address] instanceof RpcError) {
            reject(api.native.cache.addr_balance_cache[coin].get('data')[address])
          } else resolve(api.native.cache.addr_balance_cache[coin].get('data')[address])
        })
      }
    }

    const useGetCurrencyBalance =
      api.is_pbaas(coin) &&
      !(address[0] === "z" && address[address.length - 1] !== "@");

    try {
      if (useGetCurrencyBalance) {
        let balance = await api.native.get_currency_balances(coin, address)
        if (balance[coin] == null) balance[coin] = 0

        if (useCache) cacheAddrBalanceResult(balance)
        return balance
      } else {
        const balanceResult = await api.native.callDaemon(coin, "z_getbalance", [address])
        const balance = {
          [coin]: balanceResult == null ? 0 : Number(balanceResult)
        }

        if (useCache) cacheAddrBalanceResult(balance)
        return balance
      }
    } catch(e) {
      if (e.code === RPC_INVALID_ADDRESS_OR_KEY) cacheAddrBalanceResult(e)
          
      throw e
    }
  };

  return api;
};