import * as userRepository from '../repositories/user.repository.js';
export const createUser = async (userData: any) => {
    const user = await userRepository.createUser(userData);

    return user;
};
