export function groupBy<T extends { [key: string]: any }>(entities: T[], fields: string[], isJunction = false): Map<any, any> {
  const groups = new Map<any, any>();

  function setEntity(obj: Record<string, any>, entity: T) {
    const m = fields.reduce((m, field, index) => {
      if (!m) return;
      const value = obj[field];
      if (value === undefined || value === null) return;
      if (!m.has(value)) {
        let newMap = index == fields.length - 1 ? <Array<T>>[] : new Map<any, any>();
        m.set(value, newMap);
        return newMap;
      }
      return m.get(value);
    }, groups) as unknown as Array<T>;

    if (m) m.push(entity);
  }

  entities.forEach((entity) => {
    if (isJunction) {
      entity.junctions.forEach((obj: any) => {
        setEntity(obj, entity);
      });
      delete entity.junctions;
    } else {
      setEntity(entity, entity);
    }
  });
  return groups;
}