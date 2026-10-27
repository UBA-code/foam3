Explicit support for PostgresDAO removed from EasyDAO.
To add, craft a services entry which sets the innerDAO to a postgres DAO.

p({
  "class": "foam.core.boot.CSpec",
  "name": "exampleDAO",
  "description": "DAO backed postgresql",
  "authenticate": true,
  "serviceScript": """
    return new foam.dao.EasyDAO.Builder(x)
      .setOf(com.example.Example.getOwnClassInfo())
      .setInnerDAO(x.get("postgresDAO"))
      .build()
  """
})
