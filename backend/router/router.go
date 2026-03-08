package router

import (
	"khairul169/garage-webui/middleware"
	"net/http"
)

func HandleApiRouter() *http.ServeMux {
	mux := http.NewServeMux()

	auth := &Auth{}
	mux.HandleFunc("POST /auth/login", auth.Login)

	router := http.NewServeMux()
	router.HandleFunc("POST /auth/logout", auth.Logout)
	router.HandleFunc("GET /auth/status", auth.GetStatus)

	config := &Config{}
	router.HandleFunc("GET /config", config.GetAll)

	buckets := &Buckets{}
	router.HandleFunc("GET /buckets", buckets.GetAll)

	browse := &Browse{}
	// Multipart routes must be registered before wildcard {key...} routes
	router.HandleFunc("POST /browse/{bucket}/multipart/create", browse.CreateMultipartUpload)
	router.HandleFunc("PUT /browse/{bucket}/multipart/upload", browse.UploadPart)
	router.HandleFunc("POST /browse/{bucket}/multipart/complete", browse.CompleteMultipartUpload)
	router.HandleFunc("POST /browse/{bucket}/multipart/abort", browse.AbortMultipartUpload)

	router.HandleFunc("GET /browse/{bucket}", browse.GetObjects)
	router.HandleFunc("GET /browse/{bucket}/{key...}", browse.GetOneObject)
	router.HandleFunc("PUT /browse/{bucket}/{key...}", browse.PutObject)
	router.HandleFunc("DELETE /browse/{bucket}/{key...}", browse.DeleteObject)

	// Proxy request to garage api endpoint
	router.HandleFunc("/", ProxyHandler)

	mux.Handle("/", middleware.AuthMiddleware(router))
	return mux
}
