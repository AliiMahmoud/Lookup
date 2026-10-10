/* global self -- this file runs in the browser (self) and in Node (module) */
// Redis commands Lookup knows by heart: argument hints and Tab completion in the Shell and Workbench,
// HELP <command>, and which commands change data (read-only connections, Production confirmation).
// One line per command: NAME|arguments|summary|group|w (w = changes data). Commands not listed
// here (modules, newer versions) are asked from the server with COMMAND INFO.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RedisCommands = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TABLE = `
APPEND|key value|Appends a string to the value of a key|string|w
DECR|key|Decrements the integer value of a key by one|string|w
DECRBY|key decrement|Decrements a number by a given amount|string|w
GET|key|Returns the string value of a key|string
GETDEL|key|Returns the value of a key and deletes the key|string|w
GETEX|key [EX seconds|PX ms|EXAT unix-time|PXAT unix-ms|PERSIST]|Returns the value of a key and sets its expiry|string|w
GETRANGE|key start end|Returns a substring of the string value|string
GETSET|key value|Sets a new value and returns the old one|string|w
INCR|key|Increments the integer value of a key by one|string|w
INCRBY|key increment|Increments a number by a given amount|string|w
INCRBYFLOAT|key increment|Increments a floating point number|string|w
LCS|key1 key2 [LEN] [IDX] [MINMATCHLEN len] [WITHMATCHLEN]|Longest common substring|string
MGET|key [key ...]|Returns the values of several keys|string
MSET|key value [key value ...]|Sets several keys|string|w
MSETNX|key value [key value ...]|Sets several keys, only if none exists|string|w
PSETEX|key milliseconds value|Sets a value and its expiry in milliseconds|string|w
SET|key value [NX|XX] [GET] [EX seconds|PX ms|EXAT unix-time|PXAT unix-ms|KEEPTTL]|Sets the string value of a key|string|w
SETEX|key seconds value|Sets a value and its expiry in seconds|string|w
SETNX|key value|Sets a value only if the key doesn't exist|string|w
SETRANGE|key offset value|Overwrites part of a string|string|w
STRLEN|key|Length of the string value|string
SUBSTR|key start end|Returns a substring (old name of GETRANGE)|string
HDEL|key field [field ...]|Deletes fields from a hash|hash|w
HEXISTS|key field|Whether a field exists in a hash|hash
HGET|key field|Returns the value of a hash field|hash
HGETALL|key|Returns all fields and values of a hash|hash
HINCRBY|key field increment|Increments the integer value of a field|hash|w
HINCRBYFLOAT|key field increment|Increments the float value of a field|hash|w
HKEYS|key|Returns all field names of a hash|hash
HLEN|key|Number of fields in a hash|hash
HMGET|key field [field ...]|Returns the values of several fields|hash
HMSET|key field value [field value ...]|Sets several fields (old form of HSET)|hash|w
HRANDFIELD|key [count [WITHVALUES]]|Returns random fields|hash
HSCAN|key cursor [MATCH pattern] [COUNT count]|Iterates over the fields of a hash|hash
HSET|key field value [field value ...]|Sets fields of a hash|hash|w
HSETNX|key field value|Sets a field only if it doesn't exist|hash|w
HSTRLEN|key field|Length of a field's value|hash
HVALS|key|Returns all values of a hash|hash
BLMOVE|source destination LEFT|RIGHT LEFT|RIGHT timeout|Moves an element between lists, waiting for one|list|w
BLMPOP|timeout numkeys key [key ...] LEFT|RIGHT [COUNT count]|Pops elements, waiting for one|list|w
BLPOP|key [key ...] timeout|Removes the first element, waiting for one|list|w
BRPOP|key [key ...] timeout|Removes the last element, waiting for one|list|w
BRPOPLPUSH|source destination timeout|Pops from one list and pushes to another, waiting|list|w
LINDEX|key index|Returns an element by its index|list
LINSERT|key BEFORE|AFTER pivot element|Inserts an element before or after another|list|w
LLEN|key|Length of a list|list
LMOVE|source destination LEFT|RIGHT LEFT|RIGHT|Moves an element between lists|list|w
LMPOP|numkeys key [key ...] LEFT|RIGHT [COUNT count]|Pops elements from the first non-empty list|list|w
LPOP|key [count]|Removes and returns the first elements|list|w
LPOS|key element [RANK rank] [COUNT num] [MAXLEN len]|Index of matching elements|list
LPUSH|key element [element ...]|Prepends elements to a list|list|w
LPUSHX|key element [element ...]|Prepends elements only if the list exists|list|w
LRANGE|key start stop|Returns a range of elements|list
LREM|key count element|Removes elements equal to a value|list|w
LSET|key index element|Sets an element by its index|list|w
LTRIM|key start stop|Trims a list to a range|list|w
RPOP|key [count]|Removes and returns the last elements|list|w
RPOPLPUSH|source destination|Pops from one list and pushes to another|list|w
RPUSH|key element [element ...]|Appends elements to a list|list|w
RPUSHX|key element [element ...]|Appends elements only if the list exists|list|w
SADD|key member [member ...]|Adds members to a set|set|w
SCARD|key|Number of members in a set|set
SDIFF|key [key ...]|Difference of sets|set
SDIFFSTORE|destination key [key ...]|Stores the difference of sets|set|w
SINTER|key [key ...]|Intersection of sets|set
SINTERCARD|numkeys key [key ...] [LIMIT limit]|Size of the intersection|set
SINTERSTORE|destination key [key ...]|Stores the intersection of sets|set|w
SISMEMBER|key member|Whether a value is a member|set
SMEMBERS|key|Returns all members of a set|set
SMISMEMBER|key member [member ...]|Whether several values are members|set
SMOVE|source destination member|Moves a member between sets|set|w
SPOP|key [count]|Removes and returns random members|set|w
SRANDMEMBER|key [count]|Returns random members|set
SREM|key member [member ...]|Removes members from a set|set|w
SSCAN|key cursor [MATCH pattern] [COUNT count]|Iterates over the members of a set|set
SUNION|key [key ...]|Union of sets|set
SUNIONSTORE|destination key [key ...]|Stores the union of sets|set|w
BZMPOP|timeout numkeys key [key ...] MIN|MAX [COUNT count]|Pops members, waiting for one|sorted-set|w
BZPOPMAX|key [key ...] timeout|Removes the highest-scored member, waiting|sorted-set|w
BZPOPMIN|key [key ...] timeout|Removes the lowest-scored member, waiting|sorted-set|w
ZADD|key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...]|Adds members or updates their scores|sorted-set|w
ZCARD|key|Number of members|sorted-set
ZCOUNT|key min max|Number of members within a score range|sorted-set
ZDIFF|numkeys key [key ...] [WITHSCORES]|Difference of sorted sets|sorted-set
ZDIFFSTORE|destination numkeys key [key ...]|Stores the difference|sorted-set|w
ZINCRBY|key increment member|Increments the score of a member|sorted-set|w
ZINTER|numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM|MIN|MAX] [WITHSCORES]|Intersection of sorted sets|sorted-set
ZINTERCARD|numkeys key [key ...] [LIMIT limit]|Size of the intersection|sorted-set
ZINTERSTORE|destination numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM|MIN|MAX]|Stores the intersection|sorted-set|w
ZLEXCOUNT|key min max|Number of members within a lexical range|sorted-set
ZMPOP|numkeys key [key ...] MIN|MAX [COUNT count]|Pops members from the first non-empty sorted set|sorted-set|w
ZMSCORE|key member [member ...]|Scores of several members|sorted-set
ZPOPMAX|key [count]|Removes and returns the highest-scored members|sorted-set|w
ZPOPMIN|key [count]|Removes and returns the lowest-scored members|sorted-set|w
ZRANDMEMBER|key [count [WITHSCORES]]|Returns random members|sorted-set
ZRANGE|key start stop [BYSCORE|BYLEX] [REV] [LIMIT offset count] [WITHSCORES]|Returns members in a range|sorted-set
ZRANGEBYLEX|key min max [LIMIT offset count]|Members within a lexical range|sorted-set
ZRANGEBYSCORE|key min max [WITHSCORES] [LIMIT offset count]|Members within a score range|sorted-set
ZRANGESTORE|dst src min max [BYSCORE|BYLEX] [REV] [LIMIT offset count]|Stores a range of members|sorted-set|w
ZRANK|key member [WITHSCORE]|Rank of a member, lowest score first|sorted-set
ZREM|key member [member ...]|Removes members|sorted-set|w
ZREMRANGEBYLEX|key min max|Removes members within a lexical range|sorted-set|w
ZREMRANGEBYRANK|key start stop|Removes members within a rank range|sorted-set|w
ZREMRANGEBYSCORE|key min max|Removes members within a score range|sorted-set|w
ZREVRANGE|key start stop [WITHSCORES]|Members in a range, highest score first|sorted-set
ZREVRANGEBYLEX|key max min [LIMIT offset count]|Members within a lexical range, reversed|sorted-set
ZREVRANGEBYSCORE|key max min [WITHSCORES] [LIMIT offset count]|Members within a score range, highest first|sorted-set
ZREVRANK|key member [WITHSCORE]|Rank of a member, highest score first|sorted-set
ZSCAN|key cursor [MATCH pattern] [COUNT count]|Iterates over members and scores|sorted-set
ZSCORE|key member|Score of a member|sorted-set
ZUNION|numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM|MIN|MAX] [WITHSCORES]|Union of sorted sets|sorted-set
ZUNIONSTORE|destination numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM|MIN|MAX]|Stores the union|sorted-set|w
XACK|key group id [id ...]|Acknowledges messages of a consumer group|stream|w
XADD|key [NOMKSTREAM] [MAXLEN|MINID [=|~] threshold] *|id field value [field value ...]|Appends an entry to a stream|stream|w
XAUTOCLAIM|key group consumer min-idle-time start [COUNT count] [JUSTID]|Claims pending messages|stream|w
XCLAIM|key group consumer min-idle-time id [id ...]|Changes the owner of pending messages|stream|w
XDEL|key id [id ...]|Removes entries from a stream|stream|w
XGROUP|CREATE|DESTROY|SETID|CREATECONSUMER|DELCONSUMER key group ...|Manages consumer groups|stream|w
XINFO|STREAM|GROUPS|CONSUMERS key [group]|Information about a stream|stream
XLEN|key|Number of entries in a stream|stream
XPENDING|key group [[IDLE min-idle-time] start end count [consumer]]|Pending messages of a group|stream
XRANGE|key start end [COUNT count]|Entries in a range of ids|stream
XREAD|[COUNT count] [BLOCK ms] STREAMS key [key ...] id [id ...]|Reads entries from streams|stream
XREADGROUP|GROUP group consumer [COUNT count] [BLOCK ms] [NOACK] STREAMS key [key ...] id [id ...]|Reads entries for a consumer group|stream|w
XREVRANGE|key end start [COUNT count]|Entries in a range of ids, newest first|stream
XSETID|key last-id|Sets the last id of a stream|stream|w
XTRIM|key MAXLEN|MINID [=|~] threshold [LIMIT count]|Trims a stream|stream|w
COPY|source destination [DB db] [REPLACE]|Copies a key|generic|w
DEL|key [key ...]|Deletes keys|generic|w
DUMP|key|Serialized value of a key|generic
EXISTS|key [key ...]|Number of the keys that exist|generic
EXPIRE|key seconds [NX|XX|GT|LT]|Sets a key's time to live in seconds|generic|w
EXPIREAT|key unix-time [NX|XX|GT|LT]|Sets a key's expiry as a Unix time|generic|w
EXPIRETIME|key|Expiry of a key as a Unix time|generic
KEYS|pattern|All keys matching a pattern (blocks the server; prefer SCAN)|generic
MIGRATE|host port key|"" destination-db timeout [COPY] [REPLACE] [AUTH password] [KEYS key ...]|Moves keys to another server|generic|w
MOVE|key db|Moves a key to another database|generic|w
OBJECT|ENCODING|FREQ|IDLETIME|REFCOUNT key|Internals of a key's value|generic
PERSIST|key|Removes a key's expiry|generic|w
PEXPIRE|key milliseconds [NX|XX|GT|LT]|Sets a key's time to live in milliseconds|generic|w
PEXPIREAT|key unix-ms [NX|XX|GT|LT]|Sets a key's expiry as a Unix time in milliseconds|generic|w
PEXPIRETIME|key|Expiry of a key as a Unix time in milliseconds|generic
PTTL|key|Time to live in milliseconds|generic
RANDOMKEY||A random key|generic
RENAME|key newkey|Renames a key|generic|w
RENAMENX|key newkey|Renames a key only if the new name is free|generic|w
RESTORE|key ttl serialized-value [REPLACE] [ABSTTL] [IDLETIME seconds] [FREQ frequency]|Creates a key from DUMP output|generic|w
SCAN|cursor [MATCH pattern] [COUNT count] [TYPE type]|Iterates over the keys|generic
SORT|key [BY pattern] [LIMIT offset count] [GET pattern ...] [ASC|DESC] [ALPHA] [STORE destination]|Sorts a list, set or sorted set|generic|w
SORT_RO|key [BY pattern] [LIMIT offset count] [GET pattern ...] [ASC|DESC] [ALPHA]|Sorts without storing|generic
TOUCH|key [key ...]|Updates the last access time of keys|generic
TTL|key|Time to live in seconds|generic
TYPE|key|Type of the value stored at a key|generic
UNLINK|key [key ...]|Deletes keys in the background|generic|w
WAIT|numreplicas timeout|Waits for replicas to acknowledge writes|generic
BITCOUNT|key [start end [BYTE|BIT]]|Number of set bits|bitmap
BITFIELD|key [GET type offset] [SET type offset value] [INCRBY type offset increment] [OVERFLOW WRAP|SAT|FAIL]|Integer fields in a string|bitmap|w
BITOP|AND|OR|XOR|NOT destkey key [key ...]|Bitwise operations between strings|bitmap|w
BITPOS|key bit [start [end [BYTE|BIT]]]|First set or clear bit|bitmap
GETBIT|key offset|Bit value at an offset|bitmap
SETBIT|key offset value|Sets or clears a bit|bitmap|w
PFADD|key [element ...]|Adds elements to a HyperLogLog|hyperloglog|w
PFCOUNT|key [key ...]|Approximate number of unique elements|hyperloglog
PFMERGE|destkey [sourcekey ...]|Merges HyperLogLogs|hyperloglog|w
GEOADD|key [NX|XX] [CH] longitude latitude member [longitude latitude member ...]|Adds places to a geo index|geo|w
GEODIST|key member1 member2 [M|KM|FT|MI]|Distance between two places|geo
GEOHASH|key member [member ...]|Geohash strings of places|geo
GEOPOS|key member [member ...]|Longitude and latitude of places|geo
GEOSEARCH|key FROMMEMBER member|FROMLONLAT lon lat BYRADIUS radius M|KM|FT|MI|BYBOX w h M|KM|FT|MI [ASC|DESC] [COUNT count [ANY]] [WITHCOORD] [WITHDIST] [WITHHASH]|Places within an area|geo
GEOSEARCHSTORE|destination source FROMMEMBER member|FROMLONLAT lon lat BYRADIUS radius M|KM|FT|MI|BYBOX w h M|KM|FT|MI [ASC|DESC] [COUNT count [ANY]] [STOREDIST]|Stores places within an area|geo|w
PSUBSCRIBE|pattern [pattern ...]|Listens for messages on channels matching patterns|pubsub
PUBLISH|channel message|Posts a message to a channel|pubsub
PUBSUB|CHANNELS [pattern]|NUMSUB [channel ...]|NUMPAT|SHARDCHANNELS [pattern]|Information about Pub/Sub|pubsub
PUNSUBSCRIBE|[pattern [pattern ...]]|Stops listening on patterns|pubsub
SPUBLISH|shardchannel message|Posts a message to a shard channel|pubsub
SSUBSCRIBE|shardchannel [shardchannel ...]|Listens for messages on shard channels|pubsub
SUBSCRIBE|channel [channel ...]|Listens for messages on channels|pubsub
SUNSUBSCRIBE|[shardchannel [shardchannel ...]]|Stops listening on shard channels|pubsub
UNSUBSCRIBE|[channel [channel ...]]|Stops listening on channels|pubsub
DISCARD||Discards the commands queued after MULTI|transactions
EXEC||Runs the commands queued after MULTI|transactions
MULTI||Starts a transaction|transactions
UNWATCH||Forgets the watched keys|transactions
WATCH|key [key ...]|Watches keys for changes before EXEC|transactions
EVAL|script numkeys [key ...] [arg ...]|Runs a Lua script|scripting|w
EVALSHA|sha1 numkeys [key ...] [arg ...]|Runs a cached Lua script|scripting|w
EVALSHA_RO|sha1 numkeys [key ...] [arg ...]|Runs a cached read-only Lua script|scripting
EVAL_RO|script numkeys [key ...] [arg ...]|Runs a read-only Lua script|scripting
FCALL|function numkeys [key ...] [arg ...]|Calls a function|scripting|w
FCALL_RO|function numkeys [key ...] [arg ...]|Calls a read-only function|scripting
FUNCTION|LIST|STATS|DUMP|LOAD|DELETE|FLUSH|RESTORE|KILL ...|Manages functions|scripting
SCRIPT|EXISTS|FLUSH|KILL|LOAD ...|Manages the Lua script cache|scripting
AUTH|[username] password|Logs in|connection
CLIENT|ID|INFO|LIST|SETNAME|GETNAME|KILL|PAUSE|UNPAUSE|NO-EVICT|TRACKING ...|Manages client connections|connection
ECHO|message|Returns the given string|connection
HELLO|[protover [AUTH username password] [SETNAME clientname]]|Handshake with the server|connection
PING|[message]|Checks that the server answers|connection
QUIT||Closes the connection|connection
RESET||Resets the connection|connection
SELECT|index|Changes the selected database|connection
ACL|CAT|DELUSER|DRYRUN|GETUSER|LIST|LOAD|LOG|SAVE|SETUSER|USERS|WHOAMI ...|Access control lists|server
BGREWRITEAOF||Rewrites the append-only file in the background|server
BGSAVE|[SCHEDULE]|Saves the database in the background|server
COMMAND|[COUNT|DOCS|GETKEYS|INFO|LIST ...]|Information about commands|server
CONFIG|GET|SET|RESETSTAT|REWRITE ...|Reads or changes the server configuration|server
DBSIZE||Number of keys in the selected database|server
DEBUG|subcommand ...|Debugging commands|server
FAILOVER|[TO host port [FORCE]] [ABORT] [TIMEOUT ms]|Fails over to a replica|server
FLUSHALL|[ASYNC|SYNC]|Deletes every key in every database|server|w
FLUSHDB|[ASYNC|SYNC]|Deletes every key in the selected database|server|w
INFO|[section ...]|Information and statistics about the server|server
LASTSAVE||Unix time of the last save|server
LATENCY|DOCTOR|GRAPH|HISTOGRAM|HISTORY|LATEST|RESET ...|Latency monitoring|server
LOLWUT|[VERSION version]|Displays computer art and the Redis version|server
MEMORY|DOCTOR|MALLOC-STATS|PURGE|STATS|USAGE key [SAMPLES count]|Memory usage|server
MODULE|LIST|LOAD|LOADEX|UNLOAD ...|Manages modules|server
MONITOR||Streams every command the server receives|server
REPLICAOF|host port|NO ONE|Makes the server a replica of another|server
ROLE||Replication role of the server|server
SAVE||Saves the database (blocks the server)|server
SHUTDOWN|[NOSAVE|SAVE] [NOW] [FORCE] [ABORT]|Stops the server|server
SLAVEOF|host port|NO ONE|Old name of REPLICAOF|server
SLOWLOG|GET [count]|LEN|RESET|The slow query log|server
SWAPDB|index1 index2|Swaps two databases|server|w
TIME||Server time|server
JSON.ARRAPPEND|key [path] value [value ...]|Appends values to an array|json|w
JSON.ARRINDEX|key path value [start [stop]]|Index of a value in an array|json
JSON.ARRINSERT|key path index value [value ...]|Inserts values into an array|json|w
JSON.ARRLEN|key [path]|Length of an array|json
JSON.ARRPOP|key [path [index]]|Removes and returns an array element|json|w
JSON.ARRTRIM|key path start stop|Trims an array|json|w
JSON.CLEAR|key [path]|Clears containers and sets numbers to 0|json|w
JSON.DEL|key [path]|Deletes a value|json|w
JSON.GET|key [INDENT indent] [NEWLINE newline] [SPACE space] [path ...]|Returns JSON values|json
JSON.MGET|key [key ...] path|Values at a path in several keys|json
JSON.MSET|key path value [key path value ...]|Sets values in several keys|json|w
JSON.MERGE|key path value|Merges a value into a JSON document|json|w
JSON.NUMINCRBY|key path value|Increments a number|json|w
JSON.OBJKEYS|key [path]|Keys of an object|json
JSON.OBJLEN|key [path]|Number of keys in an object|json
JSON.SET|key path value [NX|XX]|Sets a JSON value|json|w
JSON.STRAPPEND|key [path] value|Appends to a string|json|w
JSON.STRLEN|key [path]|Length of a string|json
JSON.TOGGLE|key path|Toggles a boolean|json|w
JSON.TYPE|key [path]|Type of a value|json
`;

  const COMMANDS = new Map();
  for (const line of TABLE.trim().split('\n')) {
    const p = line.split('|');
    // The arguments may contain '|' (alternatives): name first, then summary, group and flag from the end.
    const write = p[p.length - 1] === 'w';
    const tail = write ? p.length - 1 : p.length;
    const group = p[tail - 1];
    const summary = p[tail - 2];
    const args = p.slice(1, tail - 2).join('|');
    COMMANDS.set(p[0], { name: p[0], args, summary, group, write });
  }

  // Changes data, server state or other clients, so blocked on read-only connections and confirmed on
  // Production even though the server doesn't flag them as writes. Key: NAME or "NAME SUBCOMMAND".
  const ADMIN = new Set([
    'SHUTDOWN', 'DEBUG', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'REPLICAOF', 'SLAVEOF', 'FAILOVER', 'MIGRATE',
    'CONFIG SET', 'CONFIG REWRITE', 'CONFIG RESETSTAT', 'SCRIPT FLUSH', 'SCRIPT KILL',
    'FUNCTION LOAD', 'FUNCTION DELETE', 'FUNCTION FLUSH', 'FUNCTION RESTORE', 'FUNCTION KILL',
    'CLIENT KILL', 'CLIENT PAUSE', 'ACL SETUSER', 'ACL DELUSER', 'ACL LOAD', 'ACL SAVE',
    'MODULE LOAD', 'MODULE LOADEX', 'MODULE UNLOAD', 'SLOWLOG RESET', 'LATENCY RESET', 'MEMORY PURGE',
    'CLUSTER RESET', 'CLUSTER FAILOVER', 'CLUSTER FORGET', 'CLUSTER MEET', 'CLUSTER ADDSLOTS', 'CLUSTER DELSLOTS',
    'CLUSTER SETSLOT', 'CLUSTER FLUSHSLOTS', 'CLUSTER REPLICATE',
  ]);

  /** 'write' (changes data), 'admin' (changes the server), 'read', or null when unknown (ask the server). */
  function kindOf(args) {
    const name = String(args[0] || '').toUpperCase();
    const sub = args.length > 1 && typeof args[1] === 'string' ? `${name} ${args[1].toUpperCase()}` : null;
    if (ADMIN.has(name) || (sub && ADMIN.has(sub))) return 'admin';
    const c = COMMANDS.get(name);
    if (!c) return null;
    return c.write ? 'write' : 'read';
  }

  /** Splits an argument hint into top-level tokens: "key [field value ...]" -> ["key", "[field value ...]"]. */
  function hintTokens(args) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of String(args || '')) {
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  /** The grey hint after what was typed (redis-cli style): the arguments not typed yet. */
  function hintFor(typedArgs, endsWithSpace) {
    const name = String(typedArgs[0] || '').toUpperCase();
    const c = COMMANDS.get(name);
    if (!c || !c.args) return '';
    const toks = hintTokens(c.args);
    let typed = typedArgs.length - 1 - (endsWithSpace ? 0 : 1);
    if (typed < 0) typed = 0;
    // Once the typed arguments reach a repeating group ("[key ...]"), keep hinting the group.
    let i = 0;
    while (typed > 0 && i < toks.length && !/\.\.\.\]?$/.test(toks[i])) { i++; typed--; }
    const rest = toks.slice(i);
    return rest.join(' ');
  }

  /** Command names starting with a prefix, for Tab completion. */
  function complete(prefix) {
    const p = String(prefix || '').toUpperCase();
    return [...COMMANDS.keys()].filter((n) => n.startsWith(p)).sort();
  }

  return { COMMANDS, kindOf, hintFor, hintTokens, complete };
});
