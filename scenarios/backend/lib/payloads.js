export function createDeclarationBody(orgId) {
  return {
    organisation: {
      id: orgId,
      name: 'Org Name',
      complianceSchemeName: null,
      schemeOperatorName: null,
      referenceNumber: '123456',
      address: {
        addressLine1: 'Test Name Ltd',
        addressLine2: '123 Street',
        town: 'Town',
        county: 'County',
        postcode: 'UK1',
        country: 'UK',
      },
      regulator: 'Environment Agency',
      regulatorEmail: 'regulator@example.gov.uk',
    },
    obligationYear: 2026,
    obligations: [
      {
        material: 'Plastic',
        recyclingTarget: 0.75,
        tonnages: {
          material: 100,
          awaitingAcceptance: 10,
          accepted: 2,
          outstanding: 20,
          obligated: 5,
        },
        status: 'NoDataYet',
      },
    ],
    obligationStatus: 'Met',
    submitterName: 'Submitter Name',
    user: {
      id: '100e35a7-c8eb-4897-8505-a8b10963e43c',
      email: 'submitter@example.com',
    },
  };
}

export function patchDeclarationBody() {
  return {
    status: 'Accepted',
    user: {
      id: '100e35a7-c8eb-4897-8505-a8b10963e43c',
      email: 'submitter@example.com',
    },
  };
}
