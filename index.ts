import * as pulumi from '@pulumi/pulumi';
import * as azure from '@pulumi/azure';
import * as azng from '@pulumi/azure-nextgen';
import * as containerService from '@pulumi/azure-nextgen/containerservice/v20200901';
import * as operationalInsights from '@pulumi/azure-nextgen/operationalinsights/v20200801';
import { ResourceGroup, getResourceGroup } from '@pulumi/azure-nextgen/resources/v20200601';
import { RandomUuid } from '@pulumi/random';

const location = 'westus';

// Create an Azure Resource Group
const resourceGroup = new ResourceGroup('resourceGroup', {
    resourceGroupName: 'josh-repro',
    location,
});
const logAnalyticsWorkspace = new operationalInsights.Workspace('logs', {
    location,
    resourceGroupName: resourceGroup.name,
    workspaceName: pulumi.interpolate`${resourceGroup.name}-log-analytics`
});

const cluster = new containerService.ManagedCluster('AKS', {
    location,
    resourceGroupName: resourceGroup.name,
    resourceName: 'aks-k8s-cluster',
    dnsPrefix: pulumi.interpolate`${resourceGroup.name}-k8s`,
    identity: {
        type: 'SystemAssigned'
    },
    agentPoolProfiles: [{
        name: 'agentpool',
        count: 1,
        vmSize: 'Standard_DS2_v2',
        mode: 'System'
    }],
    networkProfile: {
        networkPlugin: 'azure'
    },
    addonProfiles: {
        KubeDashboard: {
            enabled: true
        },
        OmsAgent: {
            enabled: true,
            config: {
                logAnalyticsWorkspaceResourceId: logAnalyticsWorkspace.id
            }
        }
    },
    enableRBAC: true
});





// Make the data easier to consume downstream.
const kubeletIdentity = cluster.identityProfile.apply(identityProfile => {
    if (identityProfile === undefined) {
        throw new Error('The `identityProfile` property is undefined.');
    }
    const ki = identityProfile.kubeletidentity;
    if (ki.clientId === undefined || ki.objectId === undefined || ki.resourceId === undefined) {
        throw new Error('The kubelet identity has at least one undefined property.');
    }
    return {
        clientId: ki.clientId,
        objectId: ki.objectId,
        resourceId: ki.resourceId
    };
});

const nodeResourceGroup = cluster.nodeResourceGroup.apply(nodeResourceGroup => {
    if (nodeResourceGroup === undefined) {
        throw new Error('The `nodeResourceGroup` property is undefined');
    }
    return getResourceGroup({ resourceGroupName: nodeResourceGroup });
});





const aksVmcAssignment = new azure.authorization.Assignment(
    'AKS cluster’s kubelet identity is a Virtual Machine Contributor',
    {
        principalId: kubeletIdentity.objectId,
        roleDefinitionName: 'Virtual Machine Contributor',
        scope: pulumi.interpolate`/subscriptions/${azng.config.subscriptionId}/resourceGroups/${nodeResourceGroup.name}`
    }
);


// <https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#managed-identity-operator>
const managedIdentityOperatorUuid = 'f1a07417-d97a-45cb-824c-7a7467783830';

const aksMioAssignment = new azng.authorization.v20150701.RoleAssignment(
    'AKS cluster’s kubelet identity is a Managed Identity Operator',
    {
        properties: {
            principalId: kubeletIdentity.objectId,
            roleDefinitionId: `/subscriptions/${azng.config.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${managedIdentityOperatorUuid}`
        },
        // scope: nodeResourceGroup.id
        scope: pulumi.interpolate`/subscriptions/${azng.config.subscriptionId}/resourceGroups/${nodeResourceGroup.name}`,
        roleAssignmentName: new RandomUuid(
            'AKS cluster’s kubelet identity is a Managed Identity Operator'
        ).result
    }
);
