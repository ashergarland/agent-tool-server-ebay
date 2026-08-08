targetScope = 'subscription'

metadata description = '''
Deploys the chatgpt-ebay connector: a user-assigned managed identity, a container registry,
a Key Vault holding the connector API key and the eBay application credentials, a Log Analytics
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

@description('Additional tags applied to every resource.')
param tags object = {}

@description('''
Deploy the Container App. The app mounts its connector API key and eBay credentials from Key
Vault, so the very first provisioning pass must run with this set to false: it creates the vault
and the identity, the bootstrap script writes the secrets, and the second pass brings the app up.
''')
param deployApp bool = true

var suffix = uniqueString(subscription().id, resourceGroupName)
var defaultTags = union(tags, {
  workload: 'chatgpt-ebay'
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
    publicBaseUrl: publicBaseUrl
    ebayEnvironment: ebayEnvironment
    ebayMarketplaceId: ebayMarketplaceId
    ebayDeliveryCountry: ebayDeliveryCountry
    ebayDeliveryPostalCode: ebayDeliveryPostalCode
    logLevel: logLevel
  }
}

output resourceGroupName string = connectorResourceGroup.name
output identityClientId string = identity.outputs.clientId
output identityPrincipalId string = identity.outputs.principalId
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output connectorUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}' : ''
output openApiUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}/openapi.json' : ''
