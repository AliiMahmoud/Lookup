/* global self -- this file runs in the browser (self) and in Node (module) */
// What Lookup's light MongoDB shell understands (a mongosh subset): the shell commands, and the db,
// collection and cursor methods with their arguments. The main process runs them; the window uses
// this list for grey hints, Tab completion and help. w = changes data.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MongoShell = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COLLECTION = `
find|filter, projection, options|Documents matching a filter (a cursor: add .sort() .limit() …)
findOne|filter, projection, options|The first matching document
countDocuments|filter, options|Number of matching documents
estimatedDocumentCount|options|Number of documents, from the collection's metadata
count|filter, options|Number of matching documents (old form of countDocuments)
distinct|field, filter|Distinct values of a field
aggregate|pipeline, options|Runs an aggregation pipeline (a cursor)
insertOne|document|Inserts a document|w
insertMany|documents, options|Inserts several documents|w
updateOne|filter, update, options|Updates the first matching document|w
updateMany|filter, update, options|Updates every matching document|w
replaceOne|filter, replacement, options|Replaces the first matching document|w
deleteOne|filter|Deletes the first matching document|w
deleteMany|filter|Deletes every matching document|w
findOneAndUpdate|filter, update, options|Updates a document and returns it|w
findOneAndReplace|filter, replacement, options|Replaces a document and returns it|w
findOneAndDelete|filter, options|Deletes a document and returns it|w
bulkWrite|operations, options|Several inserts, updates and deletes|w
createIndex|keys, options|Creates an index|w
createIndexes|indexSpecs|Creates several indexes|w
dropIndex|nameOrKeys|Drops an index|w
dropIndexes|names|Drops indexes (all but _id when none given)|w
getIndexes||The collection's indexes
indexes||The collection's indexes
drop||Drops the collection|w
renameCollection|newName|Renames the collection|w
stats||Size and counts of the collection
`;
  const CURSOR = `
sort|sort|Order of the documents
limit|n|At most n documents
skip|n|Skips the first n documents
project|projection|Fields to return
projection|projection|Fields to return
hint|index|Uses this index
maxTimeMS|ms|Stops the query after ms milliseconds
batchSize|n|Documents per round trip
collation|collation|Language rules for comparing text
comment|text|A comment shown in the server's logs
count||Number of matching documents
size||Number of matching documents
itcount||Number of documents the cursor returns
toArray||All documents
pretty||(no effect: output is always formatted)
explain|verbosity|The query plan: queryPlanner, executionStats or allPlansExecution
`;
  const DB = `
getCollection|name|A collection by name (for names with dots or dashes)
getSiblingDB|name|Another database on the same server
getCollectionNames||Names of the collections
getCollectionInfos|filter|Details of the collections
getName||The current database's name
stats||Size and counts of the database
runCommand|command|Runs a database command
adminCommand|command|Runs a command on the admin database
createCollection|name, options|Creates a collection|w
createView|name, source, pipeline|Creates a view|w
dropDatabase||Drops the current database|w
version||The server's version
serverStatus||Server statistics
hello||The server's role in its replica set or cluster
isMaster||Old name of hello
currentOp|filter|Operations running on the server
killOp|opid|Stops an operation|w
`;
  const SHELL = `
show dbs||Lists the databases with their sizes
show databases||Lists the databases with their sizes
show collections||Lists the collections of the current database
show tables||Lists the collections of the current database
use|database|Switches to another database
it||Shows the next documents of the last query
db||Prints the current database's name
help||What this shell understands
cls||Clears the screen
exit||Closes this Shell tab
`;
  const table = (text) => new Map(text.trim().split('\n').map((l) => {
    const [name, args, summary, w] = l.split('|');
    return [name, { name, args, summary, write: w === 'w' }];
  }));
  const COLLECTION_METHODS = table(COLLECTION);
  const CURSOR_METHODS = table(CURSOR);
  const DB_METHODS = table(DB);
  const SHELL_COMMANDS = table(SHELL);

  /** Hint for what is being typed: { text } of the arguments still to type, or null. */
  function hint(line) {
    const s = String(line);
    const m = /\.([A-Za-z]+)\(([^()]*)$/.exec(s); // inside the last call
    if (m) {
      const name = m[1];
      const before = s.slice(0, m.index);
      const isDbMethod = /^\s*db$/.test(before) && DB_METHODS.has(name);
      const isCursor = /\)\s*$/.test(before);
      const spec = isDbMethod ? DB_METHODS.get(name) : isCursor ? CURSOR_METHODS.get(name) || COLLECTION_METHODS.get(name) : COLLECTION_METHODS.get(name);
      if (!spec || !spec.args) return null;
      const typed = m[2].trim() ? m[2].split(',').length - (/,\s*$/.test(m[2]) ? 0 : 1) : 0;
      const rest = spec.args.split(', ').slice(typed);
      return rest.length ? { text: rest.join(', ') + ')', summary: spec.summary } : { text: ')', summary: spec.summary };
    }
    const u = /^\s*(show|use)\s*$/.exec(s);
    if (u) return { text: u[1] === 'show' ? ' dbs | collections' : ' <database>', summary: '' };
    return null;
  }

  /**
   * Names that can follow what is typed (Tab): shell commands at the start, db methods and collection
   * names after "db.", collection methods after "db.<collection>.", cursor methods after a call.
   */
  function completions(line, collections = []) {
    const s = String(line);
    let m = /^(\s*)([A-Za-z]*)$/.exec(s);
    if (m) return { from: m[1].length, prefix: m[2], items: [...new Set([...SHELL_COMMANDS.keys()].map((k) => k.split(' ')[0]))].concat(['db']).filter((n) => n.startsWith(m[2])) };
    m = /^(\s*show\s+)([A-Za-z]*)$/.exec(s);
    if (m) return { from: m[1].length, prefix: m[2], items: ['dbs', 'databases', 'collections', 'tables'].filter((n) => n.startsWith(m[2])) };
    m = /^(\s*db\.)([\w$]*)$/.exec(s);
    if (m) return { from: m[1].length, prefix: m[2], items: [...collections, ...DB_METHODS.keys()].filter((n) => n.startsWith(m[2])) };
    m = /^(\s*db\.(?:[\w$]+|getCollection\([^)]*\))\.)([\w$]*)$/.exec(s);
    if (m) return { from: m[1].length, prefix: m[2], items: [...COLLECTION_METHODS.keys()].filter((n) => n.startsWith(m[2])) };
    m = /^(.*\)\s*\.)([\w$]*)$/.exec(s);
    if (m) return { from: m[1].length, prefix: m[2], items: [...CURSOR_METHODS.keys()].filter((n) => n.startsWith(m[2])) };
    return { from: s.length, prefix: '', items: [] };
  }

  const HELP = `Lookup's MongoDB shell runs one command at a time, like mongosh:

  show dbs                              databases with their sizes
  show collections                      collections of the current database
  use <database>                        switch database
  db.<collection>.find({ … })           documents (add .sort({ … }) .limit(n) .skip(n) .project({ … }))
  db.<collection>.aggregate([ … ])      aggregation pipeline
  db.<collection>.insertOne({ … })      also insertMany, updateOne/Many, replaceOne, deleteOne/Many
  db.<collection>.countDocuments({ … }) also distinct, findOne, createIndex, getIndexes, stats
  db.getCollection('name')              collections with dots or dashes in their names
  db.runCommand({ … })                  any database command (db.adminCommand for admin)
  it                                    next documents of the last query
  cls                                   clear the screen

Values: { a: 1 }, 'text', ObjectId('…'), ISODate('…'), Long('…'), Decimal128('…'), /regex/i
Not supported: variables, functions, loops and other JavaScript.`;

  return { COLLECTION_METHODS, CURSOR_METHODS, DB_METHODS, SHELL_COMMANDS, hint, completions, HELP };
});
