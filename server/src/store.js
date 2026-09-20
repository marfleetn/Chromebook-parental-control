// @chpc/server — store facade.
// db.js IS the store (node:sqlite, zero native deps). This file exists so the
// package exports map ("./store") stays honest and gives extension authors a
// single import name for the data layer.
export * from './db.js';
