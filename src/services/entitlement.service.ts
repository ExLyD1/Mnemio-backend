import * as subscriptionRepo from '../repositories/subscription.repository.js';
import { PremiumRequiredError } from '../shared/errors.js';

export const assertPremium = async (userId: string): Promise<void> => {
    const entitled = await subscriptionRepo.isEntitled(userId);
    if (!entitled) throw new PremiumRequiredError();
};

export const getPlan = async (userId: string): Promise<'free' | 'premium'> => {
    const entitled = await subscriptionRepo.isEntitled(userId);
    return entitled ? 'premium' : 'free';
};
