const core = require('@actions/core');
const { request, gql, GraphQLClient } = require('graphql-request')

// Railway Required Inputs
const RAILWAY_API_TOKEN = core.getInput('RAILWAY_API_TOKEN');
const PROJECT_ID = core.getInput('PROJECT_ID');
const SRC_ENVIRONMENT_NAME = core.getInput('SRC_ENVIRONMENT_NAME');
const SRC_ENVIRONMENT_ID = core.getInput('SRC_ENVIRONMENT_ID');
const DEST_ENV_NAME = core.getInput('DEST_ENV_NAME');
const ENV_VARS = core.getInput('ENV_VARS');
const ENDPOINT = 'https://backboard.railway.app/graphql/v2';

// Github Required Inputs
const BRANCH_NAME = core.getInput('branch_name') || "feat-railway-7";

// Optional Inputs
const DEPLOYMENT_MAX_TIMEOUT = core.getInput('MAX_TIMEOUT');

async function railwayGraphQLRequest(query, variables) {
    const client = new GraphQLClient(ENDPOINT, {
        headers: {
            Authorization: `Bearer ${RAILWAY_API_TOKEN}`,
        },
    })
    try {
        return await client.request({ document: query, variables })
    } catch (error) {
        core.setFailed(`Action failed with error: ${error}`);
    }
}

async function getEnvironments() {
    let query =
        `query environments($projectId: String!) {
            environments(projectId: $projectId) {
                edges {
                    node {
                        id
                        name
                        deployments {
                            edges {
                                node {
                                    id
                                    status
                                }
                            }
                        }
                        serviceInstances {
                            edges {
                                node {
                                    id
                                    domains {
                                        serviceDomains {
                                            domain
                                        }
                                    }
                                    serviceId
                                    startCommand
                                }
                            }
                        }
                    }
                }
            }
        }`

    const variables = {
        "projectId": PROJECT_ID,
    }

    return await railwayGraphQLRequest(query, variables)
}

async function createEnvironment(sourceEnvironmentId) {
    console.log("Creating Environment... based on source environment ID:", sourceEnvironmentId)
    try {
        let query = gql`
        mutation environmentCreate($input: EnvironmentCreateInput!) {
            environmentCreate(input: $input) {
                id
                name
                createdAt
                deploymentTriggers {
                    edges {
                        node {
                            id
                            environmentId
                            branch
                            projectId
                        }
                    }
                }
                serviceInstances {
                    edges {
                        node {
                            id
                            domains {
                                serviceDomains {
                                    domain
                                    id
                                }
                            }
                            serviceId
                        }
                    }
                }
            }
        }
        `
        const variables = {
            input: {
                "name": DEST_ENV_NAME,
                "projectId": PROJECT_ID,
                "sourceEnvironmentId": sourceEnvironmentId
            }
        }
        return await railwayGraphQLRequest(query, variables);
    } catch (error) {
        core.setFailed(`Action failed with error: ${error}`);
    }
}

async function updateEnvironment(environmentId, serviceId, variables) {
    const parsedVariables = JSON.parse(variables);

    try {
        let query = gql`
        mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
        }
        `

        let variables = {
            input: {
                "environmentId": environmentId,
                "projectId": PROJECT_ID,
                "serviceId": serviceId,
                "variables": parsedVariables
            }
        }

        return await railwayGraphQLRequest(query, variables)
    } catch (error) {
        core.setFailed(`Action failed with error: ${error}`);
    }
}

async function deploymentTriggerUpdate(deploymentTriggerId) {
    console.log("Updating Deploying Trigger to new Branch Name")
    try {
        let query = gql`
        mutation deploymentTriggerUpdate($id: String!, $input: DeploymentTriggerUpdateInput!) {
            deploymentTriggerUpdate(id: $id, input: $input) {
                id
            }
        }
        `

        let variables = {
            id: deploymentTriggerId,
            input: {
                "branch": BRANCH_NAME,
            }
        }

        return await railwayGraphQLRequest(query, variables)
    } catch (error) {
        core.setFailed(`Action failed with error: ${error}`);
    }
}

async function monitorDeploymentStatus() {
    const parsedTimeout = parseInt(DEPLOYMENT_MAX_TIMEOUT);
    const MAX_TIMEOUT = isNaN(parsedTimeout) ? 600000 : parsedTimeout;

    const startTime = Date.now();

    while (true) { // Infinite loop, but we have break and throw conditions inside.
        if (Date.now() - startTime > MAX_TIMEOUT) {
            throw new Error('Maximum timeout duration reached trying to monitor deployment. Exiting.');
        }

        // Get Environments to check if the deployment has finished
        let response = await getEnvironments();

        const filteredEdges = response?.environments?.edges?.filter((edge) => edge.node.name === DEST_ENV_NAME);

        if (!filteredEdges || filteredEdges.length === 0) {
            throw new Error('Unexpected response structure or environment not found. Exiting.');
        }

        let deploymentStatus = filteredEdges[0]?.node?.deployments?.edges?.[0]?.node?.status;

        if (!deploymentStatus) {
            throw new Error('Deployment status not found in the response. Exiting.');
        }

        if (deploymentStatus === 'SUCCESS') {
            break;  // Exit the loop
        } else if (deploymentStatus === 'FAILED') {
            throw new Error('Deployment failed. Please check the Railway Dashboard for more information.');
        } else if (['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING'].includes(deploymentStatus)) {
            console.log('Deployment is still in progress. Status:', deploymentStatus, '. Waiting 20 seconds and trying again...');
            await new Promise(resolve => setTimeout(resolve, 20000)); // Wait for 20 seconds and try again
        } else {
            throw new Error(`Unhandled deployment status. Please check the Railway Dashboard for more information. Status: ${deploymentStatus}. Response: ${JSON.stringify(response)}`);
        }
    }
}

async function serviceInstanceRedeploy(environmentId, serviceId) {
    console.log("Redeploying Service...")
    console.log("Environment ID:", environmentId)
    console.log("Service ID:", serviceId)
    try {
        let query = gql`
        mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) {
            serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)
        }
        `

        let variables = {
            "environmentId": environmentId,
            "serviceId": serviceId
        }

        return await railwayGraphQLRequest(query, variables)
    } catch (error) {
        core.setFailed(`Action failed with error: ${error}`);
    }
}

async function run() {
    try {
        // Get Environments to check if the environment already exists
        let response = await getEnvironments();

        // Filter the response to only include the environment name we are looking to create
        const filteredEdges = response.environments.edges.filter((edge) => edge.node.name === DEST_ENV_NAME);

        // If there is a match this means the environment already exists
        if (filteredEdges.length == 1) {
            throw new Error('Environment already exists. Please delete the environment via API or Railway Dashboard and try again.')
        }

        let srcEnvironmentId = SRC_ENVIRONMENT_ID;

        // If no source ENV_ID provided get Source Environment ID to base new PR environment from (aka use the same environment variables)
        if (!SRC_ENVIRONMENT_ID) {
            srcEnvironmentId = response.environments.edges.filter((edge) => edge.node.name === SRC_ENVIRONMENT_NAME)[0].node.id;
        }

        // Create the new Environment based on the Source Environment
        const createdEnvironment = await createEnvironment(srcEnvironmentId);
        console.log("Created Environment:")
        console.dir(createdEnvironment, { depth: null })

        const { id: environmentId } = createdEnvironment.environmentCreate;
        const { id: deploymentTriggerId } = createdEnvironment.environmentCreate.deploymentTriggers.edges[0].node;

        // Get the Service ID
        const { serviceId } = createdEnvironment.environmentCreate.serviceInstances.edges[0].node;

        // Update the Environment Variables
        const updatedEnvironmentVariables = await updateEnvironment(environmentId, serviceId, ENV_VARS);

        // Wait for the created environment to finish initializing
        console.log("Waiting 15 seconds for deployment to initialize and become available")
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait for 15 seconds

        // Wait for the initial deployment (which is autocreated by createEnvironment) to finish, otherwise you cannot run concurrent deployments
        await monitorDeploymentStatus();

        // Set the Deployment Trigger Branch
        await deploymentTriggerUpdate(deploymentTriggerId);

        // Redeploy the Service
        await serviceInstanceRedeploy(environmentId, serviceId);

        const { domain } = createdEnvironment.environmentCreate.serviceInstances.edges[0].node.domains.serviceDomains[0];
        console.log('Domain:', domain)
        core.setOutput('service_domain', domain);
    } catch (error) {
        console.error('Error in API calls:', error);
        // Handle the error, e.g., fail the action
        core.setFailed('API calls failed');
    }
}

run();