import * as userService from '../services/user.service.js';

export const createUser = async (request: any, reply: any) => {
    const newUser = await userService.createUser(request.body);

    const response = {
        status: 'success',
        data: newUser,
    };

    reply.send(response);
};
