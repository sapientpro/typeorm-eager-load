TypeORM Eager Loader
================

The eagerLoad function allows you to load entity relations in a separate query with eager selects for all related entities over an IN operator. It provides an alternative to the default lazy loading behavior of TypeORM, which loads relations with multiple queries.


## Installation

Install the package using npm:

```
npm install @sapientpro/typeorm-eager-load --save
```

Install the package using npm:
```
yarn add @sapientpro/typeorm-eager-load
```

And configure datasource once in your application:

```typescript
import { setEagerDataSource } from '@sapientpro/typeorm-eager-load';

setEagerDataSource(dataSource)
```

## Usage

Import the eagerLoad function from the typeorm-eager-loader package:

```typescript
import { eagerLoad } from '@sapientpro/typeorm-eager-load';
```
Then, use it to load entity relations:

```typescript
const posts = await connection.getRepository(Post).findMany();
await eagerLoad(posts, ['comments.user']);
```

The first parameter to the eagerLoad function is an array of instances of one entity. The second parameter is an array of strings, where each string is a relation name to load.

### Relation Definition

You can also use a relation definition to configure relations:

```typescript
await eagerLoad(posts, {
  comments: (builder, { loadWith }) => {
    loadWith('user.roles');
  }
});
```

The relation definition is an object where the key is the relation name and the value is a closure that defines how to load the relation.

The closure takes two parameters:

- `builder`: The query builder for the relation.
- `context`: An object that provides additional options for loading the relation.

### EagerContext

The `context` parameter of the relation definition closure is an instance of the `EagerContext` class. It provides additional methods for loading relations.

#### filter

The `filter` method allows you to filter the main entities (e.g., posts) by some condition:

```typescript
await eagerLoad(posts, [
  {
    comments: (builder, { filter }) => {
      filter((post) => post.id % 2 === 0);
    }
  }
]);
```

In this example, only for posts with an even ID will comments be loaded.

#### loadWith

The `loadWith` method allows you to load nested relations:

```typescript
await eagerLoad(posts, [
  {
    'comments': (builder, { loadWith }) => {
      loadWith('user.roles');
    }
  }
]);
```

In this example, the `user` and `roles` relations will be loaded for each comment.

#### lateral

You can also use the `lateral` method to apply a lateral join to the relation. Here's an example that uses context.lateral() to order the comments by id and limit the number of comments loaded for each post to 3:

```typescript
await eagerLoad(posts, [
  {
    'comments': (builder, { lateral }) => {
      lateral((builder) => {
        builder.orderBy('comment.id', 'DESC').limit(3)
      }, 'commentCount');
    }
  }
]);
```

## Contributing
Contributions are welcome! If you have any bug reports, feature requests, or patches, please [open an issue](https://github.com/sapientpro/typeorm-eager-loader/issues) or create a [pull request](https://github.com/sapientpro/typeorm-eager-loader/pulls).

## License
This package is licensed under the [MIT License](https://github.com/sapientpro/typeorm-eager-loader/blob/master/LICENSE).






