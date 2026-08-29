targetScope = 'subscription'

metadata description = '''
Deploys the agent-tool-server-ebay service while retaining legacy Azure resource names: a
user-assigned managed identity, a container registry,
a Key Vault holding the connector API key, the eBay application credentials and the eBay
marketplace account deletion verification token, a Log Analytics
workspace, and a Container App that runs the connector image. The identity is deliberately given
no Azure data-plane RBAC beyond pulling its own image and reading its own Key Vault secrets — the
connector only talks to the public eBay APIs.
'''

@description('Short environment name used to derive resource names, e.g. prod or dev.')
@minLength(2)
@maxLength(10)
param environmentName string = 'prod'

@description('Azure region for all connector resources.')
param location string = deployment().location

@description('Resource group that will hold the connector resources.')
param resourceGroupName string = 'rg-chatgpt-ebay-${environmentName}'

@description('Container image to run. Leave as the default placeholder for the first deployment, then redeploy with the real tag.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Public HTTPS base URL the connector is reachable on. Set after the first deployment so the OpenAPI document advertises the right server.')
param publicBaseUrl string = ''

@description('Which eBay environment the connector talks to.')
@allowed(['production', 'sandbox'])
param ebayEnvironment string = 'production'

@description('Default eBay marketplace for tools that do not specify one.')
param ebayMarketplaceId string = 'EBAY_US'

@description('Two letter country code used as the buyer context for shipping quotes. Empty to omit.')
param ebayDeliveryCountry string = ''

@description('Postal code used as the buyer context for shipping quotes. Requires ebayDeliveryCountry. Empty to omit.')
param ebayDeliveryPostalCode string = ''

@description('Log level for the connector.')
@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
param logLevel string = 'info'

@description('''
Public HTTPS URL of the eBay Marketplace Account Deletion/Closure callback, exactly as registered
in the eBay developer portal. It is derived from the ingress hostname and is therefore supplied by
the bootstrap scripts once the Container App exists; it is not part of the environment parameter
file. The verification token that pairs with it is a Key Vault secret, never a parameter.
''')
param accountDeletionEndpointUrl string = ''

@description('Minimum number of replicas. Zero lets the app scale to nothing when idle.')
@minValue(0)
param minReplicas int = 0

@description('Maximum number of replicas.')
@minValue(1)
param maxReplicas int = 3

@description('Additional tags applied to every resource.')
param tags object = {}

@description('''
Deploy the Container App. The app mounts its connector API key, eBay credentials and eBay
account deletion verification token from Key
Vault, so the very first provisioning pass must run with this set to false: it creates the vault
and the identity, the bootstrap script writes the secrets, and the second pass brings the app up.
''')
param deployApp bool = true

@description('Deploy an availability test and alert that notify when the connector stops answering /health. Requires alertEmails or alertSmsPhone to be set, otherwise the alert would have nowhere to fire.')
param enableHealthAlerts bool = false

@description('Email addresses notified when the connector goes down. Supply through an external operator parameter file or at deployment time; do not commit personal addresses to this public repository.')
param alertEmails array = []

@description('Phone number notified by SMS when the connector goes down, digits only.')
param alertSmsPhone string = ''

@description('Country code for the SMS number, e.g. 1 for the United States.')
param alertSmsCountryCode string = '1'

var suffix = uniqueString(subscription().id, resourceGroupName)
var defaultTags = union(tags, {
  workload: 'agent-tool-server-ebay'
  environment: environmentName
  managedBy: 'bicep'
})

resource connectorResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: defaultTags
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: connectorResourceGroup
  params: {
    name: 'id-chatgpt-ebay-${environmentName}'
    location: location
    tags: defaultTags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'registry'
  scope: connectorResourceGroup
  params: {
    name: 'acrchatgptebay${suffix}'
    location: location
    tags: defaultTags
    pullPrincipalId: identity.outputs.principalId
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  scope: connectorResourceGroup
  params: {
    name: 'kv-cgeb-${suffix}'
    location: location
    tags: defaultTags
    readerPrincipalId: identity.outputs.principalId
  }
}

module logAnalytics 'modules/log-analytics.bicep' = {
  name: 'log-analytics'
  scope: connectorResourceGroup
  params: {
    name: 'log-chatgpt-ebay-${environmentName}'
    location: location
    tags: defaultTags
  }
}

module containerApp 'modules/container-app.bicep' = if (deployApp) {
  name: 'container-app'
  scope: connectorResourceGroup
  params: {
    environmentName: 'cae-chatgpt-ebay-${environmentName}'
    appName: 'ca-chatgpt-ebay-${environmentName}'
    location: location
    tags: defaultTags
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    identityId: identity.outputs.id
    image: image
    registryLoginServer: registry.outputs.loginServer
    apiKeySecretUri: '${keyVault.outputs.uri}secrets/connector-api-key'
    ebayClientIdSecretUri: '${keyVault.outputs.uri}secrets/ebay-client-id'
    ebayClientSecretSecretUri: '${keyVault.outputs.uri}secrets/ebay-client-secret'
    ebayAccountDeletionTokenSecretUri: '${keyVault.outputs.uri}secrets/ebay-account-deletion-token'
    publicBaseUrl: publicBaseUrl
    ebayEnvironment: ebayEnvironment
    ebayMarketplaceId: ebayMarketplaceId
    ebayDeliveryCountry: ebayDeliveryCountry
    ebayDeliveryPostalCode: ebayDeliveryPostalCode
    accountDeletionEndpointUrl: accountDeletionEndpointUrl
    logLevel: logLevel
    minReplicas: minReplicas
    maxReplicas: maxReplicas
  }
}

// Availability monitoring is opt-in: it only makes sense once the app exists and an owner has
// said where to send alerts. Deploying it with no receivers would create an alert that fires
// into nothing, which is worse than no alert because it looks like coverage.
module monitoring 'modules/monitoring.bicep' = if (deployApp && enableHealthAlerts) {
  name: 'monitoring'
  scope: connectorResourceGroup
  params: {
    name: 'chatgpt-ebay-${environmentName}'
    location: location
    tags: defaultTags
    connectorUrl: 'https://${containerApp!.outputs.fqdn}'
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    alertEmails: alertEmails
    alertSmsPhone: alertSmsPhone
    alertSmsCountryCode: alertSmsCountryCode
  }
}

output resourceGroupName string = connectorResourceGroup.name
output identityClientId string = identity.outputs.clientId
output identityPrincipalId string = identity.outputs.principalId
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output connectorUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}' : ''
output openApiUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}/openapi.json' : ''
output mcpUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}/mcp' : ''

// The exact string the operator pastes into the eBay developer portal. It must match the value
// passed as accountDeletionEndpointUrl byte for byte, because eBay hashes it during endpoint
// validation.
output accountDeletionCallbackUrl string = deployApp
  ? 'https://${containerApp!.outputs.fqdn}/ebay/notifications/marketplace-account-deletion'
  : ''
