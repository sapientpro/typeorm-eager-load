import { AsyncLocalStorage } from "node:async_hooks";
import { DataSource } from "typeorm";

const als = new AsyncLocalStorage<DataSource>();

let eagerDataSource: null | DataSource = null;


export function setEagerDataSource(dataSource: DataSource) {
  eagerDataSource = dataSource;
}

export function runWithDataSource<R, TArgs extends any[]>(dataSource: DataSource, callback: (...args: TArgs) => R, ...args: TArgs): R {
  return als.run(dataSource, callback, ...args);
}

export function getEagerDataSource() {
  const dataSource =  als.getStore() ?? eagerDataSource;
  if(!dataSource) {
    throw new Error('Data source not set');
  }
  return dataSource;
}