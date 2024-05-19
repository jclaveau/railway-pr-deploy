const core = require(`@actions/core`)
const { request, gql, GraphQLClient } = require(`graphql-request`)

// Railway Required Inputs
const RAILWAY_API_TOKEN = core.getInput(`RAILWAY_API_TOKEN`)
const PROJECT_ID = core.getInput(`PROJECT_ID`)
const SRC_ENVIRONMENT_NAME = core.getInput(`SRC_ENVIRONMENT_NAME`)
const SRC_ENVIRONMENT_ID = core.getInput(`SRC_ENVIRONMENT_ID`)
const DEST_ENV_NAME = core.getInput(`DEST_ENV_NAME`)
const ENV_VARS = core.getInput(`ENV_VARS`)
const API_SERVICE_NAME = core.getInput(`API_SERVICE_NAME`)
const IGNORE_SERVICE_REDEPLOY = core.getInput(`IGNORE_SERVICE_REDEPLOY`)
const ENDPOINT = `https://backboard.railway.app/graphql/v2`

// Github Required Inputs
const BRANCH_NAME = core.getInput(`branch_name`) || `feat-railway-7`

// Optional Inputs
const DEPLOYMENT_MAX_TIMEOUT = core.getInput(`MAX_TIMEOUT`)

async function railwayGraphQLRequest(query, variables) {
  const client = new GraphQLClient(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${RAILWAY_API_TOKEN}`,
    },
  })
  return await client.request({ document: query, variables })
}

async function getProject() {
  let query =
    `query project($id: String!) {
            project(id: $id) {
                name
                services {
                    edges {
                        node {
                            id
                            name
                        }
                    }
                }
                environments {
                    edges {
                        node {
                            id
                            name
                            serviceInstances {
                                edges {
                                    node {
                                        serviceId
                                        startCommand
                                        domains {
                                            serviceDomains {
                                                domain
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }`

  const variables = {
    "id": PROJECT_ID,
  }

  return await railwayGraphQLRequest(query, variables)
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
  console.log(`Creating Environment... based on source environment ID:`, sourceEnvironmentId)
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
        "sourceEnvironmentId": sourceEnvironmentId,
      },
    }
    return await railwayGraphQLRequest(query, variables)
  }
  catch (error) {
    core.setFailed(`createEnvironment failed with error: ${error}`)
  }
}

async function updateEnvironment(environmentId, serviceId, variables) {
  const parsedVariables = JSON.parse(variables)

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
        "variables": parsedVariables,
      },
    }

    return await railwayGraphQLRequest(query, variables)
  }
  catch (error) {
    core.setFailed(`updateEnvironment failed with error: ${error}`)
  }
}

async function deploymentTriggerUpdate(deploymentTriggerId) {
  console.log(`Updating Deploying Trigger to new Branch Name`)
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
      },
    }

    return await railwayGraphQLRequest(query, variables)
  }
  catch (error) {
    core.setFailed(`deploymentTriggerUpdate failed with error: ${error}`)
  }
}

async function serviceInstanceRedeploy(environment, service) {
  console.log(`Redeploying Service: ${environment.name} / ${service.name} (${environment.id} / ${service.id})`)
  try {
    const query = gql`
        mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) {
            serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)
        }
        `

    const variables = {
      "environmentId": environment.id,
      "serviceId": service.id,
    }

    return await railwayGraphQLRequest(query, variables)
  }
  catch (error) {
    console.error(`Redeploying ${environment.name} / ${service.name} failed:`, error)
    core.setFailed(`Redeploying ${environment.name} / ${service.name} failed: ${JSON.stringify(error, null, 2)}`)
  }
}

async function updateAllDeploymentTriggers(deploymentTriggerIds) {
  try {
    // Create an array of promises
    const updatePromises = deploymentTriggerIds.map((deploymentTriggerId) =>
      deploymentTriggerUpdate(deploymentTriggerId))

    // Await all promises
    await Promise.allSettled(updatePromises)
    console.log(`All deployment triggers updated successfully.`)
  }
  catch (error) {
    console.error(`An error occurred during the update:`, error)
  }
}

async function updateEnvironmentVariablesForServices(environmentId, serviceInstances, ENV_VARS) {
  const serviceIds = []

  // Extract service IDs
  for (const serviceInstance of serviceInstances.edges) {
    const { serviceId } = serviceInstance.node
    serviceIds.push(serviceId)
  }

  try {
    // Create an array of promises for updating environment variables
    const updatePromises = serviceIds.map((serviceId) =>
      updateEnvironment(environmentId, serviceId, ENV_VARS))

    // Await all promises to complete
    await Promise.allSettled(updatePromises)
    console.log(`Environment variables updated for all services.`)
  }
  catch (error) {
    console.error(`An error occurred during the update:`, error)
  }
}

async function redeployAllServices(environment, servicesToRedeploy) {
  try {
    // Create an array of promises for redeployments
    const redeployPromises = servicesToRedeploy.map((service) =>
      serviceInstanceRedeploy(environment, service))

    // Await all promises to complete
    await Promise.allSettled(redeployPromises)
    console.log(`All services redeployed successfully.`)
  }
  catch (error) {
    console.error(`An error occurred during redeployment:`, error)
  }
}

async function getService(serviceId) {
  let query =
    `query service($id: String!) {
        service(id: $id) {
          id
          name
        }
    }`

  const variables = {
    "id": serviceId,
  }

  return await railwayGraphQLRequest(query, variables)
}


function projectEnvironmentTokenName() {
  return `GITHUB_${DEST_ENV_NAME}_AUTOGENERATED`
}

async function getProjectEnvironmentToken(environment) {


  let query =
    `query projectTokens($projectId: String!) {
      projectTokens(projectId: $projectId) {
        edges {
          node {
            name
            id
            environment {
              name
              id
            }
            displayToken
          }
        }
      }
    }`

  const variables = {
    "projectId": PROJECT_ID,
  }

  const response = await railwayGraphQLRequest(query, variables)
  // console.log('!!!! tokens edges', JSON.stringify({
  //   environment,
  //   tokens: response.projectTokens.edges
  // }, null, 2))
  return response.projectTokens.edges
    .map((edge) => {
      return edge.node
    })
    .find((tokenNode) => {
      const hasMatchingName = tokenNode.name == projectEnvironmentTokenName()
      if (hasMatchingName && tokenNode.environment.id != environment.id) {
        throw new Error(`Project token for the environment '${environment.name}' is not bound to the expected environment: ${JSON.stringify(tokenNode, null, 2)}`)
      }
      return hasMatchingName
    })
}

async function deleteProjectEnvironmentToken(projectTokenId) {
  const query = gql`
    mutation projectTokenDelete($id: String!) {
      projectTokenDelete(id: $id)
    }
  `

  const variables = {
    "id": projectTokenId,
  }

  await railwayGraphQLRequest(query, variables)
}


async function createProjectEnvironmentToken(environment) {
  const query = gql`
    mutation projectTokenCreate($input: ProjectTokenCreateInput!) {
      projectTokenCreate(input: $input)
    }
  `
  const variables = {
    input: {
      "environmentId": environment.id,
      "projectId": PROJECT_ID,
      "name": projectEnvironmentTokenName(),
    }
  }

  let response
  try {
    response = await railwayGraphQLRequest(query, variables)
  }
  catch (error) {
    console.error(`Creating project token for the environment '${environment.name}' failed:`, JSON.stringify(error, null, 2))
    throw error
  }
  // console.info(`Created project token for the environment '${environment.name}'`, JSON.stringify(createdToken, null, 2))
  console.info(`Created project token for the environment '${environment.name}'`)
  return response.projectTokenCreate
}

async function refreshProjectEnvironmentToken(environment) {
  const token = await getProjectEnvironmentToken(environment)
  if (token) {
    console.info(`Refreshing existing project token found for the environment '${environment.name}'`, JSON.stringify(token, null, 2))
    await deleteProjectEnvironmentToken(token.id)
  }
  else {
    console.info(`No project token found for the environment '${environment.name}'. Creating one.`)
  }
  return await createProjectEnvironmentToken(environment)
}

async function run() {
  try {
    // Get Environments to check if the environment already exists
    let response = await getEnvironments()

    // Filter the response to only include the environment name we are looking to create
    const filteredEdges = response.environments.edges.filter((edge) => edge.node.name === DEST_ENV_NAME)

    // If there is a match this means the environment already exists
    let environment
    let serviceInstances
    let deploymentTriggers
    if (filteredEdges.length == 1) {
      environment = filteredEdges[0].node
      serviceInstances = environment.serviceInstances
      deploymentTriggers = environment.deploymentTriggers
      console.info(`Environment '${DEST_ENV_NAME}' already exists: '${filteredEdges[0].node.id}'. Skipping creation.`)
    }
    else {
      let srcEnvironmentId = SRC_ENVIRONMENT_ID

      // If no source ENV_ID provided get Source Environment ID to base new PR environment from (aka use the same environment variables)
      if (!SRC_ENVIRONMENT_ID) {
        srcEnvironmentId = response.environments.edges.filter((edge) => edge.node.name === SRC_ENVIRONMENT_NAME)[0].node.id
      }

      // Create the new Environment based on the Source Environment
      const createdEnvironment = await createEnvironment(srcEnvironmentId)
      console.log(`Created Environment:`)
      console.dir(createdEnvironment, { depth: null })

      environment = createdEnvironment.environmentCreate
      deploymentTriggers = createdEnvironment.environmentCreate.deploymentTriggers

      // Get all the Service Instances
      // const { serviceInstances } = createdEnvironment.environmentCreate
      serviceInstances = createdEnvironment.environmentCreate.serviceInstances
    }

    console.log(`serviceInstances:`, JSON.stringify(serviceInstances, null, 2))

    // Generate PR env token
    const projectEnvironmentToken = await refreshProjectEnvironmentToken(environment)
    core.setOutput(`pr_project_token`, projectEnvironmentToken)

    // Get all the Deployment Triggers
    const deploymentTriggerIds = []
    for (const deploymentTrigger of deploymentTriggers.edges) {
      const { id: deploymentTriggerId } = deploymentTrigger.node
      deploymentTriggerIds.push(deploymentTriggerId)
    }

    // Update the Environment Variables on each Service Instance
    await updateEnvironmentVariablesForServices(environment.id, serviceInstances, ENV_VARS)

    // Wait for the created environment to finish initializing
    console.log(`Waiting 15 seconds for deployment to initialize and become available`)
    await new Promise((resolve) => setTimeout(resolve, 15000)) // Wait for 15 seconds

    // Set the Deployment Trigger Branch for Each Service 
    await updateAllDeploymentTriggers(deploymentTriggerIds)

    const servicesToIgnore = IGNORE_SERVICE_REDEPLOY ? JSON.parse(IGNORE_SERVICE_REDEPLOY) : []
    const servicesToRedeploy = []

    // Get the names for each deployed service
    for (const serviceInstance of serviceInstances.edges) {
      const { domains } = serviceInstance.node
      const { service } = await getService(serviceInstance.node.serviceId)
      const { name } = service

      if (!servicesToIgnore.includes(name)) {
        servicesToRedeploy.push(service)
      }

      if ((API_SERVICE_NAME && name === API_SERVICE_NAME) || name === `app` || name === `backend` || name === `web`) {
        const { domain } = domains.serviceDomains?.[0]
        console.log(`Domain:`, domain)
        core.setOutput(`service_domain`, domain)
      }
    }

    // Redeploy the Services
    await redeployAllServices(environment, servicesToRedeploy)
    // TODO start plugins services
  }
  catch (error) {
    console.error(`Error in API calls:`, error)
    // Handle the error, e.g., fail the action
    core.setFailed(`API calls failed`)
  }
}

run()