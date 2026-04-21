import Fastify from 'fastify';
import userRoutes from './routes/user.routes.ts';

import EventEmitter from 'node:events';

const fastify = Fastify({
    logger: true,
});

// Declare a route
fastify.get('/', function (request, reply) {
    reply.send({ hello: 'world' });
});

userRoutes(fastify);

// Register an event
const eventEmitter = new EventEmitter();

// listen to the event
eventEmitter.on('createBulkUsers', (user) => {
    setTimeout(() => {
        console.log('Bulk users created');
    }, 3000);
    console.log('Bulk user created ==> ', user);
});

fastify.post('/create-bulk-users', async (request, reply) => {
    const { users } = request.body;
    // ...

    eventEmitter.emit('createBulkUsers', users);
    reply.send({ message: 'We have requested to create 10,000 users, it may take some time!!' });
});

fastify.get('/hello', (request, reply) => {
    reply.send({ hello: 'world!' });
});

fastify.listen({ port: 3000, host: '0.0.0.0' }, function (err, address) {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info(`Server listening on ${address}`);
});
