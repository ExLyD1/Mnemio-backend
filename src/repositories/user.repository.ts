export const createUser = async (userData: any) => {
    const { name, email } = userData;
    // Here you would typically add logic to save the user to a database
    // For this example, we'll just return the user data as a response
    return { message: 'User created successfully', user: { name, email } };
};
