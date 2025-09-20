import type { ObjectLiteral } from "typeorm";

export function extractIds<Entity extends ObjectLiteral>(entities: Entity[], columnNames: string[]) {
  const entityIds: Array<any[]> = [];
  const map = new Map<any, any>();
  entities.forEach((entity) => {
    let m = map;
    const id = [];
    let add = false;
    for (let columnName of columnNames) {
      const value = entity[columnName];
      if (value === undefined || value === null) return;
      id.push(value);
      if (m.has(value)) {
        m = m.get(value);
      } else {
        add = true;
        const newMap = new Map<any, any>();
        m.set(value, newMap);
        m = newMap;
      }
    }
    if (add) {
      entityIds.push(id);
    }
  });

  return entityIds;
}