
function EstimatedCostTableRow(low, mid, high, severe) {
    return {
        ["LOW"]: low,
        ["MID"]: mid, 
        ["HIGH"]: high,
        ["SEVERE"]: severe
    };
}

const EstimatedCostInDays = {

    ["XS"]: EstimatedCostTableRow(  0.5,   1,   1.5,   4),
    ["S"]:  EstimatedCostTableRow(  2,     3,   4.5,  12),
    ["M"]:  EstimatedCostTableRow(  4,     5,   7.5,  20),
    ["L"]:  EstimatedCostTableRow(  7.5,  10,  15,    40),
    ["XL"]: EstimatedCostTableRow( 15,    20,  30,    80),
};

function computeEstimatedCost(size, risk) {
    const sizeKey = size?.split('(')[0].trim().toUpperCase();
    const riskKey = risk?.split(':')[0].trim().toUpperCase();

    if (!(sizeKey in EstimatedCostInDays)) {
        const errMsg = `Invalid Size specifier: original value: "${size}"; key: "${sizeKey}".`;
        console.log(errMsg);
        throw new Error(errMsg);
    }

    const costTableRow = EstimatedCostInDays[sizeKey];

    if (!(riskKey in costTableRow)) {
        const errMsg = `Invalid Risk specifier: original value: "${risk}"; key: "${riskKey}".`;
        console.log(errMsg);
        throw new Error(errMsg);
    }

    const estimate = costTableRow[riskKey];
    console.log(`EstimatedCostInDays[${sizeKey}][${riskKey}]: '${estimate}'`);
    return estimate;
}

const axios = require('axios');

const TOKEN_PROJECT_ACCESS = process.env.TOKEN_PROJECT_ACCESS_RW;
const GH_ORG_NAME = process.env.GH_ORG_NAME;
const GH_PROJECT_ID = process.env.GH_PROJECT_ID;

if (!TOKEN_PROJECT_ACCESS) {
    throw new Error("`TOKEN_PROJECT_ACCESS` is missing.");
}

if (!GH_ORG_NAME) {
    throw new Error("`GH_ORG_NAME` is missing.");
}

if (!GH_PROJECT_ID) {
    throw new Error("`GH_PROJECT_ID` is missing.");
}

async function graphql(query, variables = {}) {
    const res = await axios.post(
        'https://api.github.com/graphql',
        { query, variables },
        {
            headers: {
                Authorization: `Bearer ${TOKEN_PROJECT_ACCESS}`,
                'Content-Type': 'application/json',
            },
        }
    );
    if (res.data.errors) {
        console.error(JSON.stringify(res.data.errors, null, 2));
        throw new Error("GraphQL error");
    }
    return res.data;
};

async function getFieldIds() {
    const query = `
        query($org: String!, $projectNumber: Int!) {
            organization(login: $org) {
                projectV2(number: $projectNumber) {
                    id
                    fields(first: 100) {
                        nodes {
                            ... on ProjectV2SingleSelectField {
                                id
                                name
                            }
                            ... on ProjectV2FieldCommon {
                                id
                                name
                            }
                        }
                    }
                }
            }
        }
    `;

    const projectNumber = parseInt(GH_PROJECT_ID, 10);

    const data = await graphql(query, {
        org: GH_ORG_NAME,
        projectNumber
    });

    const fields = data.data.organization.projectV2.fields.nodes;

    const getFieldIdByName = (name) => {
        const field = fields.find(f => f.name.toLowerCase() === name.toLowerCase());
        if (!field) throw new Error(`Field "${name}" not found`);
        return field.id;
    };

    return {
        estimationHackFieldId: getFieldIdByName("Estimation Hack"),
        projectId: data.data.organization.projectV2.id
    };
}

async function getProjectItems(projectId) {
    const query = `
        query($projectId: ID!, $cursor: String) {
            node(id: $projectId) {
                ... on ProjectV2 {
                    items(first: 100, after: $cursor) {
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                        nodes {
                            id
                            content {
                                ... on DraftIssue {
                                    title
                                }
                                ... on Issue {
                                    title
                                }
                                ... on PullRequest {
                                    title
                                }
                            }
                            fieldValues(first: 50) {
                                nodes {
                                    ... on ProjectV2ItemFieldSingleSelectValue {
                                        name
                                        field {
                                            ... on ProjectV2FieldCommon {
                                                name
                                            }
                                        }
                                    }
                                    ... on ProjectV2ItemFieldNumberValue {
                                        number
                                        field {
                                            ... on ProjectV2FieldCommon {
                                                name
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    let items = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
        const variables = {
            projectId: projectId,
            cursor: cursor,
        };

        const data = await graphql(query, variables);
        const page = data.data.node.items;

        items.push(...page.nodes);
        hasNextPage = page.pageInfo.hasNextPage;
        cursor = page.pageInfo.endCursor;
    }

    return items;
}

async function updateEstimationHack(projectId, itemId, fieldId, value) {
    const mutation = `
        mutation($input: UpdateProjectV2ItemFieldValueInput!) {
            updateProjectV2ItemFieldValue(input: $input) {
                projectV2Item {
                    id
                }
            }
        }
    `;

    await graphql(mutation, {
        input: {
            projectId,
            itemId,
            fieldId,
            value: {
                number: value
            }
        }
    });
}

async function main() {
    const { estimationHackFieldId, projectId } = await getFieldIds();

    const items = await getProjectItems(projectId);

    let countTotalItems = 0;
    let countChangedItems = 0;
    let countErrItems = 0;
    for (const item of items) {

        try {
            countTotalItems++;
            const title = item.content?.title || "(no title)";

            const fields = item.fieldValues.nodes ?? [];

            const size = fields.find(f => f.field?.name.toLowerCase() === "size")?.name;
            const risk = fields.find(f => f.field?.name.toLowerCase() === "risk")?.name;

            if (!size) {
                console.log(`Skipping item (missing Size): id='${item.id}', title="${title}".`);
                continue;
            }

            if (!risk) {
                console.log(`Skipping item (missing Risk): id='${item.id}', title="${title}".`);
                continue;
            }

            const estimate = computeEstimatedCost(size, risk);

            const existingEstimate = fields.find(f => f.field?.name.toLowerCase() === "estimation hack")?.number;
            if (existingEstimate === estimate) {
                console.log(`Estimation Hack unchanged (${estimate}), no update required: id='${item.id}', title="${title}".`);
                continue;
            }

            await updateEstimationHack(projectId, item.id, estimationHackFieldId, estimate);
            countChangedItems++;
            console.log(`Updated item Estimation Hack '${estimate}': id='${item.id}', title="${title}".`);
            
        } catch(err) {
            countErrItems++;
            console.log(`Error processing item id='${item.id}', title="${title}": "${err.message ?? err}"`);
        }
    }

    console.log(`Finished.`
        + ` countTotalItems='${countTotalItems}';`
        + ` countChangedItems='${countChangedItems}';`
        + ` countErrItems='${countErrItems}'`);
}

main().catch(err => {
    console.error("Script failed:", err);
    process.exit(1);
});